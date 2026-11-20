import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppError,
  appError,
  authorizeExchangeJoin,
  classifyMimeType,
  commitExchangeBusiness,
  encodeExchangeHistoryCursor,
  type Configuration,
  err,
  EXCHANGE_LEASE_SECONDS,
  EXCHANGE_READ_BYTES,
  type ExchangeLeaseResult,
  type ExchangeActionData,
  type ExchangeActionFor,
  type ExchangeActivationWarning,
  type ExchangeClaim,
  type ExchangeHistoryCursor,
  type ExchangeWaitPage,
  exchangeAccessDenied,
  type ExchangeBodyInput,
  type ExchangeBusinessInput,
  type ExchangeBusinessRepository,
  type ExchangeBusinessResult,
  type ExchangeCapturedInput,
  type ExchangeCapturedBody,
  exchangeCount,
  type ExchangeInput,
  exchangeInvalid,
  exchangeProjection,
  type ExchangeLifecycleInput,
  type ExchangeMaterialAvailability,
  type ExchangeMaterialPage,
  type ExchangeOutcome,
  type ExchangeRange,
  type ExchangeReadInput,
  type ExchangeView,
  exchangeView,
  type ExchangeReadDecision,
  expandConfigurationPath,
  isMemoUuid,
  isExchangeBusiness,
  isExchangeRead,
  matchExchangeFingerprint,
  isUtf8ExactText,
  normalizeExchangeRanges,
  ok,
  type Project,
  type ProjectBinding,
  type ProjectResolutionPorts,
  planExchangeBusiness,
  resolveWorkspaceActor,
  requireExchangeClaim,
  readExchangeHistoryCursor,
  runExchangeCommand,
  unconfirmedExchangeRanges,
  waitForExchangeActivity,
  type Result,
} from "@sorage/core";
import { createConfigStore } from "./config-store";
import {
  exchangeAcceptances,
  insertExchangeAcceptance,
  exchangeMaterial,
  exchangeMessages,
  exchangeOperations,
  exchangeReports,
  exchangeRequests,
  relevantExchangeMessages,
} from "./exchange-collaboration-records";
import {
  type BoundExchangeSource,
  digestExchangeSource,
  exchangeSourceChunks,
  readExchangeOriginal,
  resolveExchangeSource,
  withExchangeSource,
} from "./exchange-sources";
import { createExchangeWorkingStore, type PreparedExchangeBody } from "./exchange-working-store";
import { createHomePaths, type HomeEnvironment, type HomePaths } from "./home";
import { createNodeLockProbePorts, vaultMoveLockHeld, vaultMovePauseRefusal } from "./lockfile";
import { createNodeResolutionBindings } from "./project-command-ports";
import { createSqliteEventLedger } from "./events";
import { createSqliteProjectRepository } from "./projects";
import { openCoveredReadStorage } from "./read-storage";
import { blockingSleepMs } from "./sleep";
import type { SorageSqlite } from "./sqlite/connection";
import { productionMigrationPlan } from "./sqlite/migrations";
import { asSchemaAdmission, openAndMigrate } from "./sqlite/migrator";
import { runInTransaction } from "./sqlite/transaction";
import { asAppCommandError, carriedAppError, storageContentionOf } from "./storage-contention";

export { contentionKindOf } from "./storage-contention";

interface Context {
  cwd: string;
  userHome: string;
  env: HomeEnvironment;
  home: HomePaths;
  config: Configuration;
  project?: string | undefined;
  asProject?: string | undefined;
  asUser?: boolean | undefined;
  now: () => Date;
  onFreshWrite?: (() => void) | undefined;
  joinAdmission?: ExchangeJoinAdmission | undefined;
  leaseOwnerAlive?: (() => boolean) | undefined;
}

export interface ExchangeCommandOptions {
  cwd?: string | undefined;
  userHome?: string | undefined;
  env?: HomeEnvironment | undefined;
  project?: string | undefined;
  asProject?: string | undefined;
  asUser?: boolean | undefined;
  now?: (() => Date) | undefined;
  onFreshWrite?: (() => void) | undefined;
  joinAdmission?: ExchangeJoinAdmission | undefined;
  leaseOwnerAlive?: (() => boolean) | undefined;
}

type Actor = { project: Project; binding: ProjectBinding };
export interface ExchangeJoinAdmission {
  exchangeId: string;
  projectId: string;
  actor: Actor;
}
type Header = {
  id: string;
  openingProjectId: string;
  goal: string;
  criteria: string;
  lastSeq: number;
  createdAt: string;
};
type Receipt = { fingerprint: string; outcome: ExchangeOutcome };

interface ContentCapture extends ExchangeCapturedBody {
  prepare(store: WorkingStore, exchangeId: string): PreparedExchangeBody;
}

type WorkingStore = ReturnType<typeof createExchangeWorkingStore>;
type Workspace = ProjectResolutionPorts["bindings"];

interface BusinessCapture {
  actor: Actor;
  facts: ExchangeCapturedInput;
  custody?: BoundExchangeSource;
  content?: ContentCapture;
}

function fail(error: AppError): never {
  throw carriedAppError(error);
}

function need<T>(result: Result<T>): T {
  if (!result.ok) return fail(result.error);
  return result.value;
}

function denied(): never {
  return fail(exchangeAccessDenied());
}

function conflict(message: string): never {
  return fail(appError("ROW_VERSION_CONFLICT", message));
}

function invalid(message: string): never {
  return fail(exchangeInvalid(message));
}

function storageFailure(error: unknown): AppError {
  return (
    asAppCommandError(error)?.error ??
    asSchemaAdmission(error) ??
    storageContentionOf(error, "exchange") ?? {
      ...appError("INTERNAL_ERROR", "The Exchange storage operation failed."),
      recovery: { suggestedCommand: "Retain this command and its output. Inspect or retry in the same mode." },
    }
  );
}

function contextOf(options: ExchangeCommandOptions): Context {
  const env = options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME };
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths(env, userHome);
  const read = need(createConfigStore({ home, userHome, lockPorts: createNodeLockProbePorts() }).readForOperation());
  if (!read)
    return fail(
      appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: home.configFile }),
    );
  return {
    ...options,
    env,
    userHome,
    home,
    cwd: options.cwd ?? process.cwd(),
    config: read.config,
    now: options.now ?? (() => new Date()),
  };
}

/** Capture physical resolution outside the SQLite transaction. Directory ties only consult lexical ancestors. */
function observeWorkspace(context: Context): Workspace {
  const ports = createNodeResolutionBindings();
  const real = ports.realPath(context.cwd, context.userHome);
  const common = real.ok ? ports.gitCommonDirectory(real.value) : null;
  const physical = new Map<string, string | null>();
  if (real.ok) {
    for (let path = real.value; ; path = dirname(path)) {
      physical.set(path, ports.physicalIdentity(path));
      if (dirname(path) === path) break;
    }
  }
  return {
    realPath: () => real,
    gitCommonDirectory: () => common,
    physicalIdentity: (path) => physical.get(path) ?? null,
  };
}

function createWorkingStore(db: SorageSqlite, context: Context): WorkingStore {
  return createExchangeWorkingStore({
    db,
    stateDir: context.home.stateDir,
    runDir: context.home.runDir,
    vaultPath: expandConfigurationPath(context.config.vault.path, context.userHome, context.home.home),
  });
}

function openExchangeWriter(context: Context): SorageSqlite {
  if (vaultMoveLockHeld(context.home.runDir)) {
    fail(vaultMovePauseRefusal(context.home.lockFile("vault-move")));
  }
  const migrations = productionMigrationPlan();
  return openAndMigrate(join(context.home.stateDir, "sorage.sqlite3"), migrations.migrations, {
    rebuilds: migrations.rebuilds,
  }).db;
}

class ExchangeStore implements ExchangeBusinessRepository {
  readonly actor: Actor;
  readonly projects: ReturnType<typeof createSqliteProjectRepository>;
  readonly working: WorkingStore;

  constructor(
    readonly db: SorageSqlite,
    readonly context: Context,
    workspace: Workspace,
    private readonly captured?: BusinessCapture,
    private readonly prepared?: PreparedExchangeBody,
  ) {
    this.projects = createSqliteProjectRepository(db, {
      installationId: context.config.installationId,
      events: createSqliteEventLedger(db),
      contentionSurface: "exchange",
    });
    const actor = need(
      resolveWorkspaceActor(
        { installationId: context.config.installationId, projects: this.projects, bindings: workspace },
        {
          path: context.cwd,
          userHome: context.userHome,
        },
      ),
    );
    if (actor.kind !== "registered_project" || actor.project.status !== "active") denied();
    for (const assertion of [context.project, context.asProject]) {
      if (assertion !== undefined && need(this.project(assertion))?.id !== actor.project.id) denied();
    }
    this.actor = actor;
    this.working = createWorkingStore(db, context);
    if (captured && !sameActor(this.actor, captured.actor)) denied();
  }

  get actorId() {
    return this.actor.project.id;
  }

  access(exchangeId: string): Header {
    const header = this.db
      .prepare(
        `SELECT e.id, opening_project_id openingProjectId, goal, criteria_json criteria, last_seq lastSeq,
        created_at createdAt FROM exchanges e JOIN exchange_members m ON m.exchange_id = e.id
        WHERE e.id = ? AND m.project_id = ?`,
      )
      .get(exchangeId, this.actorId) as Header | undefined;
    return header ?? denied();
  }

  project(value: string) {
    if (!isMemoUuid(value)) return this.projects.findProjectBySlug(value);
    const projects = this.projects.listProjects();
    return projects.ok ? ok(projects.value.find((project) => project.id === value) ?? null) : projects;
  }

  activeMember(exchangeId: string, projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM exchange_members m JOIN projects p ON p.id = m.project_id
      WHERE m.exchange_id = ? AND m.project_id = ? AND p.status = 'active'`)
        .get(exchangeId, projectId),
    );
  }

  hasMessage(exchangeId: string, seq: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM exchange_messages WHERE exchange_id = ? AND seq = ?").get(exchangeId, seq),
    );
  }

  hasMaterial(exchangeId: string, materialId: string): boolean {
    return Boolean(exchangeMaterial(this.db, exchangeId, materialId));
  }

  claim(exchangeId: string): ExchangeClaim | null {
    return (
      (this.db
        .prepare(
          "SELECT claim_id claimId, expires_at expiresAt FROM exchange_claims WHERE exchange_id = ? AND project_id = ?",
        )
        .get(exchangeId, this.actorId) as ExchangeClaim | undefined) ?? null
    );
  }

  now(): Date {
    return this.context.now();
  }
  newId(): string {
    return randomUUID();
  }

  createExchange(id: string, goal: string, criteria: string[], members: string[]): void {
    this.db
      .prepare("INSERT INTO exchanges (id,opening_project_id,goal,criteria_json,created_at) VALUES (?,?,?,?,?)")
      .run(id, this.actorId, goal, JSON.stringify(criteria), this.now().toISOString());
    const member = this.db.prepare("INSERT INTO exchange_members VALUES (?,?)");
    for (const projectId of members) member.run(id, projectId);
  }

  addRequest(exchangeId: string, row: Parameters<ExchangeBusinessRepository["addRequest"]>[1]): void {
    this.db
      .prepare("INSERT INTO exchange_requests VALUES (?,?,?,?,?,?,?)")
      .run(
        exchangeId,
        row.id,
        row.requesterId,
        row.assigneeId,
        row.assignmentVersion,
        row.condition,
        JSON.stringify(row.criteria),
      );
  }

  addReport(exchangeId: string, row: Parameters<ExchangeBusinessRepository["addReport"]>[1]): void {
    this.db
      .prepare("INSERT INTO exchange_reports VALUES (?,?,?,?,?,?,?)")
      .run(
        exchangeId,
        row.requestId,
        row.version,
        row.assignmentVersion,
        row.authorId,
        row.materialId,
        JSON.stringify(row.evidence),
      );
  }

  addAcceptance(exchangeId: string, row: Parameters<ExchangeBusinessRepository["addAcceptance"]>[1]): void {
    insertExchangeAcceptance(this.db, exchangeId, row);
  }

  addMaterial(exchangeId: string, input: Parameters<ExchangeBusinessRepository["addMaterial"]>[1]): string {
    const materialId = this.newId();
    const body = input.kind === "body" || input.kind === "copy" ? this.prepared : undefined;
    if (
      (input.kind === "body" || input.kind === "copy") &&
      (body?.exchangeId !== exchangeId || body.sizeBytes !== input.sizeBytes || body.sha256 !== input.sha256)
    )
      return conflict("The verified prepared Exchange body no longer matches this operation.");
    if (body) this.working.record(body);
    const scope =
      input.kind === "copy" || input.kind === "live" || input.kind === "versioned"
        ? this.captured?.custody
        : input.scope;
    this.db
      .prepare(
        `INSERT INTO exchange_materials (exchange_id,id,owner_project_id,kind,content_id,size_bytes,sha256,scope_json,available)
      VALUES (?,?,?,?,?,?,?,?,1)`,
      )
      .run(
        exchangeId,
        materialId,
        this.actorId,
        input.kind,
        body?.id ?? null,
        input.sizeBytes,
        input.sha256,
        scope == null ? null : JSON.stringify(scope),
      );
    return materialId;
  }

  private seq(exchangeId: string): number {
    const row = this.db
      .prepare("UPDATE exchanges SET last_seq = last_seq + 1 WHERE id = ? AND last_seq < ? RETURNING last_seq seq")
      .get(exchangeId, Number.MAX_SAFE_INTEGER) as { seq: number } | undefined;
    return row?.seq ?? invalid("The Exchange sequence is exhausted.");
  }

  appendMessage(exchangeId: string, row: Parameters<ExchangeBusinessRepository["appendMessage"]>[1]): number {
    const seq = this.seq(exchangeId);
    this.db
      .prepare("INSERT INTO exchange_messages VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        exchangeId,
        seq,
        this.actorId,
        row.recipientId,
        row.kind,
        row.replyTo,
        row.materialId,
        row.requestId,
        row.reportVersion,
        this.now().toISOString(),
      );
    return seq;
  }

  latestReport(exchangeId: string, requestId: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) version FROM exchange_reports WHERE exchange_id = ? AND request_id = ?")
      .get(exchangeId, requestId) as { version: number | null } | undefined;
    return row?.version ?? 0;
  }

  request(exchangeId: string, requestId: string) {
    return exchangeRequests(this.db, exchangeId).find((entry) => entry.id === requestId);
  }

  isAccepted(exchangeId: string, requestId: string, reportVersion: number): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM exchange_acceptances WHERE exchange_id = ? AND request_id = ? AND report_version = ?")
        .get(exchangeId, requestId, reportVersion),
    );
  }

  currentReceipt(input: ExchangeBusinessInput): Receipt | null {
    if (input.kind === "create") {
      const row = this.db
        .prepare(
          "SELECT fingerprint, exchange_id exchangeId FROM exchange_creation_outcomes WHERE project_id = ? AND operation_id = ?",
        )
        .get(this.actorId, input.operationId) as { fingerprint: string; exchangeId: string } | undefined;
      if (!row) return null;
      this.access(row.exchangeId);
      return { fingerprint: row.fingerprint, outcome: { kind: "create", exchangeId: row.exchangeId } };
    }
    this.access(input.exchangeId);
    const row = this.db
      .prepare(
        "SELECT fingerprint, outcome_json outcome FROM exchange_operation_outcomes WHERE exchange_id = ? AND project_id = ? AND operation_id = ?",
      )
      .get(input.exchangeId, this.actorId, input.operationId) as { fingerprint: string; outcome: string } | undefined;
    return row ? { fingerprint: row.fingerprint, outcome: JSON.parse(row.outcome) } : null;
  }

  saveOutcome(outcome: ExchangeOutcome, operationId: string, fingerprint: string): void {
    if (outcome.kind === "create") {
      this.db
        .prepare("INSERT INTO exchange_creation_outcomes VALUES (?,?,?,?)")
        .run(this.actorId, operationId, outcome.exchangeId, fingerprint);
    } else {
      this.db
        .prepare("INSERT INTO exchange_operation_outcomes VALUES (?,?,?,?,?)")
        .run(outcome.exchangeId, this.actorId, operationId, fingerprint, JSON.stringify(outcome));
    }
  }

  outcomeData(outcome: ExchangeOutcome, replayed: boolean): ExchangeBusinessResult {
    const material =
      "materialId" in outcome ? exchangeMaterial(this.db, outcome.exchangeId, outcome.materialId) : undefined;
    let availability: ExchangeMaterialAvailability | undefined;
    if (material) {
      if (!material.available)
        availability = material.kind === "body" || material.kind === "copy" ? "omitted" : "unavailable";
      else if (material.contentId !== null) {
        const body = this.db
          .prepare("SELECT materialized FROM exchange_working_content WHERE id = ? AND exchange_id = ?")
          .get(material.contentId, outcome.exchangeId) as { materialized: number } | undefined;
        availability = body?.materialized ? "available" : "pending";
      } else availability = "available";
    }
    return { ...outcome, replayed, ...(availability === undefined ? {} : { availability }) };
  }

  private ranges(exchangeId: string): ExchangeRange[] {
    return this.db
      .prepare<ExchangeRange>(
        "SELECT first_seq firstSeq, last_seq lastSeq FROM exchange_read_ranges WHERE exchange_id = ? AND project_id = ? ORDER BY first_seq",
      )
      .all(exchangeId, this.actorId);
  }

  private memberIds(exchangeId: string): string[] {
    return this.db
      .prepare<{ projectId: string }>(
        "SELECT project_id projectId FROM exchange_members WHERE exchange_id = ? ORDER BY project_id",
      )
      .all(exchangeId)
      .map((entry) => entry.projectId);
  }

  private view(header: Header): ExchangeView {
    const { id: exchangeId, criteria, ...base } = header;
    return exchangeView(
      { ...base, exchangeId, criteria: JSON.parse(criteria) },
      this.actorId,
      this.memberIds(exchangeId),
      exchangeRequests(this.db, exchangeId),
      exchangeReports(this.db, exchangeId),
      exchangeAcceptances(this.db, exchangeId),
      this.ranges(exchangeId),
    );
  }

  lifecycle(input: ExchangeLifecycleInput): ExchangeActionData {
    const { exchangeId } = input;
    const header = this.access(exchangeId);
    if (input.kind === "join") {
      const admitted = this.context.joinAdmission;
      if (admitted && (admitted.exchangeId !== exchangeId || !sameActor(admitted.actor, this.actor))) return denied();
      this.requireLiveOwner();
      const now = this.context.now();
      need(authorizeExchangeJoin(this.claim(exchangeId), input.replaceClaim, input.confirmed, now));
      this.context.onFreshWrite?.();
      const claimId = randomUUID();
      const expiresAt = new Date(now.getTime() + EXCHANGE_LEASE_SECONDS * 1_000).toISOString();
      this.db
        .prepare(
          "INSERT INTO exchange_claims VALUES (?,?,?,?) ON CONFLICT(exchange_id,project_id) DO UPDATE SET claim_id=excluded.claim_id,expires_at=excluded.expires_at",
        )
        .run(exchangeId, this.actorId, claimId, expiresAt);
      const view = this.view(header);
      this.requireLiveOwner();
      return { ...view, claimId, expiresAt };
    }
    if (input.kind === "renew" || input.kind === "release") return this.maintainLease(input);
    need(requireExchangeClaim(this.claim(exchangeId), input.claim, this.now()));
    if (input.ranges.length === 0) return invalid("Confirm at least one exact delivered sequence or range.");
    const requested = need(normalizeExchangeRanges(input.ranges));
    const previous = this.ranges(exchangeId);
    const newlyConfirmed = unconfirmedExchangeRanges(requested, previous);
    for (const range of newlyConfirmed) {
      const row = this.db
        .prepare("SELECT COUNT(*) count FROM exchange_messages WHERE exchange_id = ? AND seq BETWEEN ? AND ?")
        .get(exchangeId, range.firstSeq, range.lastSeq) as { count: number } | undefined;
      if (row?.count !== range.lastSeq - range.firstSeq + 1)
        return invalid("Read confirmation crosses a sequence without a visible message.");
    }
    const changed = newlyConfirmed.length > 0;
    const readRanges = changed ? need(normalizeExchangeRanges([...previous, ...newlyConfirmed])) : previous;
    if (changed) {
      this.context.onFreshWrite?.();
      this.db
        .prepare("DELETE FROM exchange_read_ranges WHERE exchange_id = ? AND project_id = ?")
        .run(exchangeId, this.actorId);
      const insert = this.db.prepare("INSERT INTO exchange_read_ranges VALUES (?,?,?,?)");
      for (const range of readRanges) insert.run(exchangeId, this.actorId, range.firstSeq, range.lastSeq);
    }
    return { exchangeId, projectId: this.actorId, readRanges, changed };
  }

  private requireLiveOwner(): void {
    if (this.context.leaseOwnerAlive?.() === false)
      fail(appError("EXCHANGE_CLAIM_CONFLICT", "The Exchange lease owner is no longer live."));
  }

  private maintainLease(input: Extract<ExchangeLifecycleInput, { kind: "renew" | "release" }>): ExchangeLeaseResult {
    const { exchangeId, claim: claimId } = input;
    this.requireLiveOwner();
    const persisted = this.claim(exchangeId);
    const now = this.now();
    const current = need(requireExchangeClaim(persisted, claimId, now));
    let expiresAt = current.expiresAt;
    this.context.onFreshWrite?.();
    if (input.kind === "renew") {
      expiresAt = new Date(now.getTime() + EXCHANGE_LEASE_SECONDS * 1_000).toISOString();
      this.db
        .prepare("UPDATE exchange_claims SET expires_at = ? WHERE exchange_id = ? AND project_id = ? AND claim_id = ?")
        .run(expiresAt, exchangeId, this.actorId, claimId);
    } else {
      this.db
        .prepare("DELETE FROM exchange_claims WHERE exchange_id = ? AND project_id = ? AND claim_id = ?")
        .run(exchangeId, this.actorId, claimId);
    }
    this.requireLiveOwner();
    return { exchangeId, projectId: this.actorId, claimId, expiresAt };
  }

  private historyCursor(header: Header, seq: number): ExchangeHistoryCursor {
    return {
      version: 1,
      exchangeId: header.id,
      projectId: this.actorId,
      seq,
      projection: exchangeProjection("active", this.memberIds(header.id)),
    };
  }

  waitPage(exchangeId: string, token?: string, requestedLimit?: number): ExchangeWaitPage {
    const header = this.access(exchangeId);
    const current = this.historyCursor(header, 0);
    const previous =
      token === undefined ? current : need(readExchangeHistoryCursor(token, exchangeId, this.actorId, header.lastSeq));
    const limit = requestedLimit ?? this.context.config.ui.defaultPageSize;
    if (!exchangeCount(limit, 1) || limit > 200) return invalid("Invalid history range.");
    const messages = relevantExchangeMessages(this.db, exchangeId, this.actorId, previous.seq, limit + 1);
    if (messages.length > limit) {
      messages.pop();
      current.seq = messages.at(-1)?.seq ?? previous.seq;
    } else {
      current.seq = header.lastSeq;
    }
    return {
      exchangeId,
      projectId: this.actorId,
      messages,
      cursor: encodeExchangeHistoryCursor(current),
      stateChanged: current.projection !== previous.projection,
    };
  }

  read(input: ExchangeReadInput): ExchangeActionData | (() => ExchangeActionData) {
    if (input.kind === "recover") {
      if (input.exchangeId !== undefined) this.access(input.exchangeId);
      const create = this.db
        .prepare<{ operationId: string; exchangeId: string }>(
          `SELECT o.operation_id operationId, o.exchange_id exchangeId FROM exchange_creation_outcomes o
          JOIN exchange_members m ON m.exchange_id = o.exchange_id AND m.project_id = o.project_id
          WHERE o.project_id = ? AND (? IS NULL OR o.exchange_id = ?) AND (? IS NULL OR o.operation_id = ?)
          ORDER BY o.operation_id`,
        )
        .all(
          this.actorId,
          input.exchangeId ?? null,
          input.exchangeId ?? null,
          input.operationId ?? null,
          input.operationId ?? null,
        );
      const operations = create.map(({ operationId, exchangeId }) => ({
        operationId,
        outcome: { kind: "create", exchangeId } as ExchangeOutcome,
      }));
      if (input.exchangeId !== undefined) {
        for (const { operationId, outcome } of exchangeOperations(this.db, input.exchangeId, this.actorId)) {
          if (input.operationId === undefined || operationId === input.operationId)
            operations.push({ operationId, outcome });
        }
      }
      return { operations };
    }
    const header = this.access(input.exchangeId);
    if (input.kind === "inspect") return this.view(header);
    if (input.kind === "history") {
      const limit = input.limit ?? this.context.config.ui.defaultPageSize;
      if (input.cursor !== undefined && input.afterSeq !== undefined)
        return invalid("Use either a history cursor or an after sequence.");
      const previous =
        input.cursor === undefined
          ? undefined
          : need(readExchangeHistoryCursor(input.cursor, input.exchangeId, this.actorId, header.lastSeq));
      const after = previous?.seq ?? input.afterSeq ?? 0;
      if (!exchangeCount(after) || !exchangeCount(limit, 1) || limit > 200) return invalid("Invalid history range.");
      const messages = exchangeMessages(this.db, input.exchangeId, after, limit + 1);
      const hasMore = messages.length > limit;
      if (hasMore) messages.pop();
      const afterSeq = messages.at(-1)?.seq ?? after;
      const seq = Math.min(afterSeq, header.lastSeq);
      return {
        exchangeId: input.exchangeId,
        messages,
        hasMore,
        afterSeq,
        lastSeq: header.lastSeq,
        cursor: encodeExchangeHistoryCursor(previous ? { ...previous, seq } : this.historyCursor(header, seq)),
      };
    }
    if (input.kind === "wait") return invalid("Wait requires the Exchange polling path.");
    if (
      !isMemoUuid(input.materialId) ||
      !exchangeCount(input.offset) ||
      !exchangeCount(input.limit, 1) ||
      input.limit > EXCHANGE_READ_BYTES
    )
      return invalid("Invalid bounded Exchange material range.");
    const material = exchangeMaterial(this.db, input.exchangeId, input.materialId);
    if (!material || !material.available)
      return fail(
        appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The registered Exchange material is unavailable.", {
          reason: material
            ? material.kind === "body" || material.kind === "copy"
              ? "omitted"
              : "revalidation-required"
            : "missing",
        }),
      );
    if (material.kind === "external")
      return { materialId: material.id, kind: material.kind, descriptor: JSON.parse(material.source ?? "null") };
    if (material.kind === "body" || material.kind === "copy") {
      if (!material.contentId || material.sizeBytes === null)
        return fail(appError("CONTENT_CORRUPTED", "The material has no working-content identity."));
      const { kind, sizeBytes } = material;
      const read = need(this.working.planRead(input.exchangeId, material.contentId, input.offset, input.limit));
      return () => dataSlice({ ...material, kind }, input.offset, need(read()), sizeBytes);
    }
    const scope: BoundExchangeSource = JSON.parse(material.source ?? "null");
    const owner = this.db
      .prepare(
        `SELECT 1 FROM exchange_members m JOIN projects p ON p.id = m.project_id
        WHERE m.exchange_id = ? AND m.project_id = ? AND p.status = 'active'`,
      )
      .get(input.exchangeId, material.ownerProjectId);
    if (!owner)
      return fail(
        appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The original supplier is no longer an active Exchange member.", {
          reason: "owner",
        }),
      );
    const bindings = need(this.projects.listBindingsForProject(material.ownerProjectId));
    const binding = bindings.find((entry) => entry.id === scope?.bindingId);
    if (!binding)
      return fail(
        appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The supplier's registered source binding is unavailable.", {
          reason: "binding",
        }),
      );
    const { kind } = material;
    return () => {
      const source = readExchangeOriginal(scope, binding, input.offset, input.limit, material.sha256);
      return {
        ...dataSlice({ ...material, kind }, input.offset, source.bytes, source.size),
        observedVersion: source.observedVersion,
        ownerProjectId: material.ownerProjectId,
      };
    };
  }
}

function dataSlice(
  material: { id: string; kind: ExchangeMaterialPage["kind"]; sha256: string | null },
  offset: number,
  bytes: Buffer,
  sizeBytes: number,
): ExchangeMaterialPage {
  const end = offset + bytes.length;
  return {
    materialId: material.id,
    kind: material.kind,
    encoding: "base64",
    bytes: bytes.toString("base64"),
    offset,
    sizeBytes,
    sha256: material.sha256,
    end: end >= sizeBytes,
    nextOffset: end >= sizeBytes ? null : end,
  };
}

function sameActor(a: Actor, b: Actor): boolean {
  return (
    a.project.id === b.project.id &&
    a.binding.id === b.binding.id &&
    a.binding.directory === b.binding.directory &&
    a.binding.bindingKind === b.binding.bindingKind &&
    a.binding.installationId === b.binding.installationId &&
    a.binding.updatedAt === b.binding.updatedAt
  );
}

function captureContent(
  context: Context,
  actor: Actor,
  body: ExchangeBodyInput | { source: BoundExchangeSource; forceBinary: boolean },
  historical: boolean,
): ContentCapture {
  const maxBytes = historical ? Number.MAX_SAFE_INTEGER : context.config.artifact.maxBytes;
  let chunks: <T>(inspect: (chunks: Iterable<Uint8Array>) => T) => T;
  let textFile: boolean;
  if ("text" in body) {
    if (!isUtf8ExactText(body.text)) return invalid("The body must contain exact Unicode text.");
    const bytes = Buffer.from(body.text, "utf8");
    textFile = true;
    chunks = (inspect) => inspect([bytes]);
  } else {
    const source =
      "source" in body ? body.source : resolveExchangeSource(actor.binding, context.cwd, body.file, 0, null);
    textFile =
      !("forceBinary" in body && body.forceBinary) &&
      classifyMimeType(source.relativePath) !== "application/octet-stream";
    chunks = (inspect) =>
      withExchangeSource(source, actor.binding, ({ fd, size }) =>
        inspect(exchangeSourceChunks(fd, source.offset, size)),
      );
  }
  const proof = chunks((bytes) => digestExchangeSource(bytes, maxBytes));
  const classification = textFile && proof.text ? "text" : "binary";
  return {
    sizeBytes: proof.sizeBytes,
    sha256: proof.sha256,
    classification,
    prepare(store, exchangeId) {
      let staged: PreparedExchangeBody | undefined;
      try {
        const prepared = chunks((bytes) => {
          staged = need(store.prepare({ exchangeId, classification, maxBytes, chunks: bytes }));
          return staged;
        });
        if (prepared.sizeBytes !== proof.sizeBytes || prepared.sha256 !== proof.sha256)
          return conflict("The Exchange source changed between capture and staging.");
        return prepared;
      } catch (error) {
        if (staged) store.discard(staged);
        throw error;
      }
    },
  };
}

function captureBusiness(
  context: Context,
  actor: Actor,
  input: ExchangeBusinessInput,
  historical: boolean,
): BusinessCapture {
  if (input.kind === "send" || input.kind === "report") {
    const content = captureContent(context, actor, input.body, historical);
    const { sizeBytes, sha256, classification } = content;
    return { actor, facts: { body: { sizeBytes, sha256, classification } }, content };
  }
  if (input.kind !== "material-register" || input.material.kind === "external") return { actor, facts: {} };
  const { kind, path, offset, length } = input.material;
  if (!exchangeCount(offset) || (length !== null && (!exchangeCount(length) || !exchangeCount(offset + length))))
    return invalid("Invalid source range.");
  const custody = resolveExchangeSource(actor.binding, context.cwd, path, offset, length);
  const content =
    kind === "copy" ? captureContent(context, actor, { source: custody, forceBinary: true }, historical) : undefined;
  const observed =
    kind === "versioned"
      ? withExchangeSource(custody, actor.binding, ({ fd, size }) =>
          digestExchangeSource(exchangeSourceChunks(fd, offset, size), Number.MAX_SAFE_INTEGER),
        )
      : content;
  if (kind === "live" && !historical) withExchangeSource(custody, actor.binding, () => undefined);
  return {
    actor,
    custody,
    ...(content === undefined ? {} : { content }),
    facts: {
      local: {
        relativePath: custody.relativePath,
        offset,
        length,
        sizeBytes: observed?.sizeBytes ?? null,
        sha256: observed?.sha256 ?? null,
      },
    },
  };
}

function readSnapshot<T>(context: Context, read: (store: ExchangeStore) => T, captured?: BusinessCapture): Result<T> {
  const workspace = observeWorkspace(context);
  const opened = openCoveredReadStorage({
    env: context.env,
    userHome: context.userHome,
    surface: "exchange",
    vaultAdmission: true,
  });
  if (!opened.ok) return opened;
  try {
    return runInTransaction(
      opened.value.db,
      "BEGIN",
      () => ok(read(new ExchangeStore(opened.value.db, context, workspace, captured))),
      { failure: storageFailure },
    );
  } finally {
    opened.value.close();
  }
}

function unavailableReplay(): never {
  return fail(appError("EXCHANGE_REPLAY_UNAVAILABLE", "The original Exchange outcome is unknown."));
}

interface Preparation {
  captured?: BusinessCapture;
}

function readCheckpoint(
  context: Context,
  input: ExchangeInput,
  preparation: Preparation,
): Result<ExchangeReadDecision> {
  if (input.kind === "wait") {
    if (
      !exchangeCount(input.timeout * 1_000, 1) ||
      !exchangeCount(input.interval * 1_000, 1) ||
      !exchangeCount(input.timeout, 1) ||
      !exchangeCount(input.interval, 1)
    )
      return err(exchangeInvalid("Wait timeout and interval must be positive whole seconds."));
    const waited = waitForExchangeActivity({
      cursor: input.cursor,
      timeoutSeconds: input.timeout,
      intervalSeconds: input.interval,
      now: () => performance.now(),
      sleep: blockingSleepMs,
      poll: (cursor) => readSnapshot(context, (store) => store.waitPage(input.exchangeId, cursor, input.limit)),
    });
    return waited.ok ? ok({ data: waited.value }) : waited;
  }
  if (!isExchangeBusiness(input)) {
    const result = readSnapshot(context, (store) => {
      if (isExchangeRead(input)) return store.read(input);
      store.access(input.exchangeId);
    });
    if (!result.ok) return result;
    return ok(
      result.value === undefined ? {} : { data: typeof result.value === "function" ? result.value() : result.value },
    );
  }
  // First authorize a capture. The second snapshot rechecks the current binding, access and receipt together.
  const observed = readSnapshot(context, (store) => {
    const receipt = store.currentReceipt(input);
    if (input.replayOnly && receipt === null) return unavailableReplay();
    if (receipt === null && input.kind !== "create")
      need(requireExchangeClaim(store.claim(input.exchangeId), input.claim, store.now()));
    return { actor: store.actor, historical: receipt !== null };
  });
  if (!observed.ok) return observed;
  const captured = captureBusiness(context, observed.value.actor, input, observed.value.historical);
  return readSnapshot(
    context,
    (store) => {
      const receipt = store.currentReceipt(input);
      if (receipt === null && (input.replayOnly || observed.value.historical)) return unavailableReplay();
      const plan = need(planExchangeBusiness(store, input, captured.facts));
      if (receipt) {
        need(matchExchangeFingerprint(receipt.fingerprint, plan.fingerprint));
        return { data: store.outcomeData(receipt.outcome, true) };
      }
      if (input.kind !== "create") need(requireExchangeClaim(store.claim(input.exchangeId), input.claim, store.now()));
      preparation.captured = captured;
      return { fingerprint: plan.fingerprint };
    },
    captured,
  );
}

function writeExchange(
  context: Context,
  input: ExchangeBusinessInput | ExchangeLifecycleInput,
  fingerprint: string | undefined,
  preparation: Preparation,
): Result<ExchangeActionData> {
  const db = openExchangeWriter(context);
  const working = createWorkingStore(db, context);
  let prepared: PreparedExchangeBody | undefined;
  let commitAttempted = false;
  let fresh = false;
  const admit = () => {
    if (!fresh) context.onFreshWrite?.();
    fresh = true;
  };
  try {
    if (isExchangeBusiness(input) && preparation.captured === undefined) {
      // The read admission may have required a known older schema to be migrated first.
      const observed = readCheckpoint(context, input, preparation);
      if (!observed.ok) return observed;
      if (observed.value.data !== undefined) return ok(observed.value.data);
      fingerprint = observed.value.fingerprint;
    }
    const captured = preparation.captured;
    if (captured?.content && "exchangeId" in input) {
      admit();
      prepared = captured.content.prepare(working, input.exchangeId);
    }
    const workspace = observeWorkspace(context);
    const committed = runInTransaction(
      db,
      "BEGIN IMMEDIATE",
      () => {
        const store = new ExchangeStore(db, context, workspace, captured, prepared);
        if (!isExchangeBusiness(input)) {
          const data = store.lifecycle(input);
          return ok({
            data,
            exchangeId: input.exchangeId,
            fresh: input.kind === "join" || ("changed" in data && data.changed),
          });
        }
        const receipt = store.currentReceipt(input);
        const plan = need(planExchangeBusiness(store, input, captured?.facts ?? {}));
        if (receipt) {
          need(matchExchangeFingerprint(receipt.fingerprint, plan.fingerprint));
          return ok({
            data: store.outcomeData(receipt.outcome, true),
            fresh: false,
            exchangeId: receipt.outcome.exchangeId,
          });
        }
        if (fingerprint !== plan.fingerprint)
          return conflict("The normalized Exchange input changed during admission.");
        const outcome = need(commitExchangeBusiness(store, input, plan, admit));
        const data = store.outcomeData(outcome, false);
        commitAttempted = true;
        return ok({ data, exchangeId: outcome.exchangeId, fresh: true });
      },
      { failure: storageFailure },
    );
    if (!committed.ok) {
      if (prepared && commitAttempted) working.discardAfterFailedCommit(prepared);
      return committed;
    }
    const { data, exchangeId } = committed.value;
    if (!committed.value.fresh) return ok(data);
    const warnings: ExchangeActivationWarning[] = [];
    const finished = prepared ? working.finish(prepared) : undefined;
    if (finished !== undefined) {
      if (!finished.ok) warnings.push(activationWarning(finished.error));
      else if ("replayed" in data) data.availability = "available";
    }
    const recovered = working.recover(exchangeId, finished?.ok === false ? prepared?.id : undefined);
    for (const failure of recovered.ok ? recovered.value.failures : [recovered.error])
      warnings.push(activationWarning(failure));
    return ok(warnings.length === 0 ? data : { ...data, warnings });
  } finally {
    if (prepared && !commitAttempted) working.discard(prepared);
    try {
      db.close();
    } catch {
      /* An already committed operation keeps its durable outcome. */
    }
  }
}

function activationWarning(error: AppError): ExchangeActivationWarning {
  return {
    code: error.code,
    message: error.message,
    recovery: {
      suggestedCommand: "Run an authorized Exchange write or join for this Exchange to retry pending material",
    },
  };
}

/** Resolve the gated MCP child's exact authority before it asks to enter the join queue. */
export function admitExchangeJoin(
  input: Extract<ExchangeLifecycleInput, { kind: "join" }>,
  options: ExchangeCommandOptions,
): Result<ExchangeJoinAdmission> {
  try {
    if (options.asUser === true) return err(exchangeAccessDenied());
    if (!isMemoUuid(input.exchangeId)) return err(exchangeInvalid("Supply an Exchange UUID."));
    const context = contextOf(options);
    const resolve = () =>
      readSnapshot(context, (store) => {
        store.access(input.exchangeId);
        return { exchangeId: input.exchangeId, projectId: store.actorId, actor: store.actor };
      });
    const first = resolve();
    if (first.ok || first.error.code !== "STORAGE_MIGRATION_REQUIRED") return first;
    openExchangeWriter(context).close();
    return resolve();
  } catch (error) {
    return err(storageFailure(error));
  }
}

export function executeExchange<Input extends ExchangeInput>(
  input: Input,
  options?: ExchangeCommandOptions,
): Result<ExchangeActionFor<Input["kind"]>>;
export function executeExchange(
  input: ExchangeInput,
  options: ExchangeCommandOptions = {},
): Result<ExchangeActionData> {
  try {
    if (options.asUser === true) return err(exchangeAccessDenied());
    const context = contextOf(options);
    const preparation: Preparation = {};
    return runExchangeCommand(
      {
        inspect: (request) => readCheckpoint(context, request, preparation),
        executeFresh: (request, fingerprint) => writeExchange(context, request, fingerprint, preparation),
      },
      input,
    );
  } catch (error) {
    return err(storageFailure(error));
  }
}
