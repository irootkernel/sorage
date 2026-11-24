import { randomUUID } from "node:crypto";
import {
  appError,
  type ExchangeActionData,
  type ExchangeBusinessInput,
  type ExchangeBusinessRepository,
  type ExchangeBusinessResult,
  type ExchangeClaim,
  type ExchangeControlInput,
  type ExchangeLifecycleHead,
  exchangeLifecycleHead,
  type ExchangeLifecycleInput,
  type ExchangeMaterialAvailability,
  type ExchangeNoticeAckInput,
  type ExchangeNoticeIncident,
  type ExchangeNoticeList,
  type ExchangeObservedRequest,
  type ExchangeOutcome,
  type ExchangeRange,
  type ExchangeReadInput,
  type ExchangeReportingClaim,
  type ExchangeTransition,
  type ExchangeView,
  type ExchangeWaitPage,
  initialOwnership,
  isCanonicalUuid,
  ok,
  resolveWorkspaceActor,
} from "@sorage/core";
import {
  exchangeAcceptances,
  exchangeMaterial,
  exchangeReports,
  exchangeRequests,
  insertExchangeAcceptance,
} from "./exchange-collaboration-records";
import {
  type Actor,
  type BusinessCapture,
  conflict,
  type Context,
  createWorkingStore,
  denied,
  type ExchangeStoreInternals,
  fail,
  type Header,
  invalid,
  need,
  type Receipt,
  type RevalidationCapture,
  sameActor,
  type WorkingStore,
  type Workspace,
} from "./exchange-context";
import { readExchangeLifecycle } from "./exchange-lifecycle-records";
import {
  admitExchangeControl,
  findRevalidationMaterial,
  normalizeExchangeControl,
  runExchangeControl,
} from "./exchange-store-control";
import {
  acquireExchangeClaim,
  checkExchangeJoinOwner,
  requireLiveExchangeOwner,
  runExchangeLifecycle,
} from "./exchange-store-lifecycle";
import {
  acknowledgeExchangeNotice,
  acquireExchangeNotice,
  admitExchangeNoticeAck,
  listExchangeNotices,
} from "./exchange-store-notices";
import { buildExchangeView, readExchangeData, readExchangeWaitPage } from "./exchange-store-read";
import type { PreparedExchangeBody } from "./exchange-working-store";
import { createSqliteProjectReader, type SqliteProjectReader } from "./projects";
import type { SorageSqlite } from "./sqlite/connection";

export class ExchangeStore implements ExchangeBusinessRepository, ExchangeStoreInternals {
  readonly actor: Actor;
  readonly projects: SqliteProjectReader;
  readonly working: WorkingStore;

  constructor(
    readonly db: SorageSqlite,
    readonly context: Context,
    workspace: Workspace,
    private readonly captured?: BusinessCapture,
    private readonly prepared?: PreparedExchangeBody,
  ) {
    this.projects = createSqliteProjectReader(db, { contentionSurface: "exchange" });
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
        WHERE e.id = ? AND m.project_id = ? AND m.active = 1`,
      )
      .get(exchangeId, this.actorId) as Header | undefined;
    return header ?? denied();
  }

  project(value: string) {
    if (!isCanonicalUuid(value)) return this.projects.findProjectBySlug(value);
    const projects = this.projects.listProjects();
    return projects.ok ? ok(projects.value.find((project) => project.id === value) ?? null) : projects;
  }

  activeMember(exchangeId: string, projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM exchange_members m JOIN projects p ON p.id = m.project_id
      WHERE m.exchange_id = ? AND m.project_id = ? AND m.active = 1 AND p.status = 'active'`)
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
    const member = this.db.prepare("INSERT INTO exchange_members (exchange_id,project_id) VALUES (?,?)");
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

  seq(exchangeId: string): number {
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
    const request = exchangeRequests(this.db, exchangeId).find((entry) => entry.id === requestId);
    const ownership = request && this.head(exchangeId).ownership.get(request.id);
    return request && ownership ? { ...request, ownership } : request;
  }

  currentReport(exchangeId: string, requestId: string): number {
    const version = this.request(exchangeId, requestId)?.ownership?.assignmentVersion;
    if (version === undefined) return this.latestReport(exchangeId, requestId);
    const row = this.db
      .prepare<{ version: number | null }>(
        "SELECT MAX(version) version FROM exchange_reports WHERE exchange_id = ? AND request_id = ? AND assignment_version = ?",
      )
      .get(exchangeId, requestId, version) as { version: number | null } | undefined;
    return row?.version ?? 0;
  }

  isAccepted(exchangeId: string, requestId: string, reportVersion: number): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM exchange_acceptances WHERE exchange_id = ? AND request_id = ? AND report_version = ?")
        .get(exchangeId, requestId, reportVersion),
    );
  }

  currentReceipt(input: ExchangeBusinessInput | ExchangeControlInput | ExchangeNoticeAckInput): Receipt | null {
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
        .prepare(`INSERT INTO exchange_operation_outcomes
        (exchange_id, project_id, operation_id, fingerprint, outcome_json, registration_after_seq)
        VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN (SELECT last_seq FROM exchanges WHERE id = ?) ELSE NULL END)`)
        .run(
          outcome.exchangeId,
          this.actorId,
          operationId,
          fingerprint,
          JSON.stringify(outcome),
          Number(outcome.kind === "material-register"),
          outcome.exchangeId,
        );
    }
  }

  outcomeData(outcome: ExchangeOutcome, replayed: boolean): ExchangeBusinessResult {
    if (outcome.kind === "resume") {
      const row = this.db
        .prepare("SELECT transition_json value FROM exchange_transitions WHERE exchange_id = ? AND seq = ?")
        .get(outcome.exchangeId, outcome.seq) as { value: string } | undefined;
      const transition = row ? (JSON.parse(row.value) as ExchangeTransition) : undefined;
      if (
        transition?.kind !== "resume" ||
        transition.pauseVersion !== outcome.pauseVersion ||
        (transition.decision !== null && typeof transition.decision !== "string")
      )
        return fail(appError("STORAGE_INTEGRITY_ERROR", "The retained Exchange resumption decision is missing."));
      return { ...outcome, replayed, decision: transition.decision };
    }
    const material =
      "materialId" in outcome && outcome.materialId
        ? exchangeMaterial(this.db, outcome.exchangeId, outcome.materialId)
        : undefined;
    let availability: ExchangeMaterialAvailability | undefined;
    if (material) {
      if (material.retired) availability = "retired";
      else if (!material.available)
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

  ranges(exchangeId: string): ExchangeRange[] {
    return this.db
      .prepare<ExchangeRange>(
        "SELECT first_seq firstSeq, last_seq lastSeq FROM exchange_read_ranges WHERE exchange_id = ? AND project_id = ? ORDER BY first_seq",
      )
      .all(exchangeId, this.actorId);
  }

  memberIds(exchangeId: string): string[] {
    return this.db
      .prepare<{ projectId: string }>(
        "SELECT project_id projectId FROM exchange_members WHERE exchange_id = ? AND active = 1 ORDER BY project_id",
      )
      .all(exchangeId)
      .map((entry) => entry.projectId);
  }

  head(exchangeId: string): ExchangeLifecycleHead {
    return exchangeLifecycleHead(readExchangeLifecycle(this.db, exchangeId));
  }

  requireActive(exchangeId: string): void {
    if (this.head(exchangeId).state !== "active") conflict("This operation requires an Active Exchange.");
  }

  advanceWork(exchangeId: string): void {
    this.db.prepare("UPDATE exchanges SET work_revision = work_revision + 1 WHERE id = ?").run(exchangeId);
  }

  observedRequests(exchangeId: string, head: ExchangeLifecycleHead): ExchangeObservedRequest[] {
    const latest = new Map(exchangeReports(this.db, exchangeId).map((row) => [row.requestId, row]));
    const accepted = new Set(
      exchangeAcceptances(this.db, exchangeId).map((row) => `${row.requestId}:${row.reportVersion}`),
    );
    return exchangeRequests(this.db, exchangeId).map((request) => {
      const ownership = head.ownership.get(request.id) ?? initialOwnership(request);
      const report = latest.get(request.id);
      const currentReport = report?.assignmentVersion === ownership.assignmentVersion ? report.version : 0;
      return { request, ownership, currentReport, accepted: accepted.has(`${request.id}:${currentReport}`) };
    });
  }

  normalizeControl(input: ExchangeControlInput): ExchangeControlInput {
    return normalizeExchangeControl(this, input);
  }

  admitControl(input: ExchangeControlInput): ExchangeTransition {
    return admitExchangeControl(this, input);
  }

  runControl(input: ExchangeControlInput, fingerprint: string, captured?: RevalidationCapture): ExchangeActionData {
    return runExchangeControl(this, input, fingerprint, captured);
  }

  revalidationMaterial(exchangeId: string, id: string) {
    return findRevalidationMaterial(this, exchangeId, id);
  }

  publicView(exchangeId: string): ExchangeView {
    return this.view(this.access(exchangeId));
  }

  view(header: Header): ExchangeView {
    return buildExchangeView(this, header);
  }

  checkJoinOwner(exchangeId: string): void {
    checkExchangeJoinOwner(this, exchangeId);
  }

  requireLiveOwner(): void {
    requireLiveExchangeOwner(this);
  }

  acquireClaim(exchangeId: string, now: Date): ExchangeClaim {
    return acquireExchangeClaim(this, exchangeId, now);
  }

  lifecycle(input: Exclude<ExchangeLifecycleInput, { kind: "cleanup" }>): ExchangeActionData {
    return runExchangeLifecycle(this, input);
  }

  listNotices(header: Header, claim?: string): ExchangeNoticeList {
    return listExchangeNotices(this, header, claim);
  }

  acquireNotice(
    input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
    write: true,
  ): ExchangeReportingClaim;
  acquireNotice(
    input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
    write: false,
  ): ExchangeReportingClaim | undefined;
  acquireNotice(
    input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
    write: boolean,
  ): ExchangeReportingClaim | undefined {
    return acquireExchangeNotice(this, input, write);
  }

  admitNoticeAck(input: ExchangeNoticeAckInput): { now: Date; header: Header; incident: ExchangeNoticeIncident } {
    return admitExchangeNoticeAck(this, input);
  }

  acknowledgeNotice(input: ExchangeNoticeAckInput, fingerprint: string): ExchangeBusinessResult {
    return acknowledgeExchangeNotice(this, input, fingerprint);
  }

  waitPage(exchangeId: string, token?: string, requestedLimit?: number): ExchangeWaitPage {
    return readExchangeWaitPage(this, exchangeId, token, requestedLimit);
  }

  read(input: ExchangeReadInput): ExchangeActionData | (() => ExchangeActionData) {
    return readExchangeData(this, input);
  }
}
