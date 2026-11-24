import { isAbsolute } from "node:path";
import { isLowercaseSha256 } from "./content";
import {
  applyExchangeTransition,
  type ExchangeLifecycle,
  type ExchangeTransitionRecord,
  exchangeControlOutcome,
  exchangeLifecycleHead,
} from "./exchange-lifecycle";
import { validExchangeNoticeOutcome } from "./exchange-notice-snapshot";
import { exchangeNoticeAckFingerprint } from "./exchange-notices";
import {
  EXCHANGE_INFORMATION_KINDS,
  type ExchangeAcceptanceReceipt,
  type ExchangeCollaboration,
  type ExchangeMaterial,
  type RetainedExchangeOperation,
  exchangeCount,
  exchangeOperationId,
  exchangeWorkflowText,
  validateExchangeExternal,
} from "./exchanges";
import { isCanonicalUtcTimestamp, isCanonicalUuid } from "./primitives/identity";
import { canonicalJson } from "./primitives/json";
import { memoObject } from "./primitives/validation";

type Row = Record<string, unknown>;
type AcceptanceBatch = { kind: ExchangeAcceptanceReceipt["kind"]; sequences: number[]; lastRequestId: string };
const sort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalExchangeCollaboration(value: ExchangeCollaboration): ExchangeCollaboration {
  return {
    lastSeq: value.lastSeq,
    messages: [...value.messages].sort((a, b) => a.seq - b.seq),
    requests: [...value.requests].sort((a, b) => sort(a.id, b.id)),
    reports: [...value.reports]
      .map((row) => ({ ...row, evidence: [...row.evidence].sort(sort) }))
      .sort((a, b) => sort(a.requestId, b.requestId) || a.version - b.version),
    acceptances: [...value.acceptances].sort(
      (a, b) => sort(a.requestId, b.requestId) || a.reportVersion - b.reportVersion,
    ),
    materials: [...value.materials].sort((a, b) => sort(a.id, b.id)),
    operations: [...value.operations].sort(
      (a, b) => sort(a.projectId, b.projectId) || sort(a.operationId, b.operationId),
    ),
  };
}

function inventory(value: unknown, fields: string[]): Row[] | null {
  return Array.isArray(value) && value.every((row) => memoObject(row, fields)) ? value : null;
}

function dimension(value: unknown): boolean {
  return value === null || exchangeCount(value);
}

function digest(value: unknown): boolean {
  return typeof value === "string" && isLowercaseSha256(value);
}

function validMaterial(row: Row, projects: Set<string>): row is Row & ExchangeMaterial {
  if (!isCanonicalUuid(row.id) || !isCanonicalUuid(row.ownerProjectId) || !projects.has(row.ownerProjectId))
    return false;
  if (row.kind === "external") {
    return (
      row.sizeBytes === null &&
      row.sha256 === null &&
      memoObject(row.scope, ["access", "value"]) &&
      (row.scope.access === "url" || row.scope.access === "run-id" || row.scope.access === "query") &&
      typeof row.scope.value === "string" &&
      validateExchangeExternal({ access: row.scope.access, value: row.scope.value })
    );
  }
  if (row.kind === "body") return exchangeCount(row.sizeBytes) && digest(row.sha256) && row.scope === null;
  if (row.kind !== "copy" && row.kind !== "live" && row.kind !== "versioned") return false;
  if (
    row.kind === "live"
      ? row.sizeBytes !== null || row.sha256 !== null
      : !exchangeCount(row.sizeBytes) || !digest(row.sha256)
  ) {
    return false;
  }
  if (
    !memoObject(row.scope, ["offset", "length"], ["root", "relativePath"]) ||
    !exchangeCount(row.scope.offset) ||
    !dimension(row.scope.length) ||
    (row.scope.length !== null && !exchangeCount(Number(row.scope.length) + row.scope.offset)) ||
    ((row.kind === "copy" || row.kind === "versioned") &&
      row.scope.length !== null &&
      row.sizeBytes !== row.scope.length)
  )
    return false;
  const { root, relativePath } = row.scope;
  if (root === undefined && relativePath === undefined) return true;
  return (
    typeof root === "string" &&
    isAbsolute(root) &&
    !root.includes("\0") &&
    typeof relativePath === "string" &&
    !relativePath.includes("\0") &&
    !relativePath.includes("\\") &&
    !isAbsolute(relativePath) &&
    relativePath.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function reportKey(request: unknown, version: unknown): string {
  return JSON.stringify([request, version]);
}

function validOutcome(
  outcome: unknown,
  exchangeId: string,
  projectId: string,
  messages: Map<number, Row>,
  materials: Map<string, ExchangeMaterial>,
  requests: Map<string, Row>,
): boolean {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return false;
  const row = outcome as Row;
  if (row.exchangeId !== exchangeId) return false;
  if (row.kind === "material-register") {
    const material = typeof row.materialId === "string" ? materials.get(row.materialId) : undefined;
    return (
      memoObject(row, ["kind", "exchangeId", "materialId"]) &&
      material?.ownerProjectId === projectId &&
      material.kind !== "body"
    );
  }
  if (row.kind === "accept") {
    return (
      memoObject(row, ["kind", "exchangeId", "sequences"]) &&
      Array.isArray(row.sequences) &&
      row.sequences.length > 0 &&
      new Set(row.sequences).size === row.sequences.length &&
      row.sequences.every((seq) => messages.get(seq)?.kind === "accept" && messages.get(seq)?.senderId === projectId)
    );
  }
  const message = exchangeCount(row.seq, 1) ? messages.get(row.seq) : undefined;
  if (message?.senderId !== projectId) return false;
  switch (row.kind) {
    case "send":
      return (
        memoObject(row, ["kind", "exchangeId", "seq", "materialId"]) &&
        EXCHANGE_INFORMATION_KINDS.some((kind) => kind === message.kind) &&
        message.materialId === row.materialId
      );
    case "request":
      if (typeof row.requestId !== "string" || requests.get(row.requestId)?.assignmentVersion !== row.assignmentVersion)
        return false;
      return (
        memoObject(row, ["kind", "exchangeId", "seq", "requestId", "assignmentVersion"]) &&
        message.kind === "request" &&
        message.requestId === row.requestId &&
        exchangeCount(row.assignmentVersion, 1)
      );
    case "report":
      return (
        memoObject(row, ["kind", "exchangeId", "seq", "requestId", "reportVersion", "materialId"]) &&
        message.kind === "report" &&
        message.requestId === row.requestId &&
        message.reportVersion === row.reportVersion &&
        message.materialId === row.materialId
      );
    default:
      return false;
  }
}

export function validateExchangeCollaboration(
  value: unknown,
  exchangeId: string,
  members: Set<string>,
  lifecycle?: ExchangeLifecycle,
  noticeOutcomes = false,
): boolean {
  if (
    !memoObject(value, ["lastSeq", "messages", "requests", "reports", "acceptances", "materials", "operations"]) ||
    !exchangeCount(value.lastSeq)
  )
    return false;
  const materials = inventory(value.materials, ["id", "ownerProjectId", "kind", "sizeBytes", "sha256", "scope"]);
  const requests = inventory(value.requests, [
    "id",
    "requesterId",
    "assigneeId",
    "assignmentVersion",
    "condition",
    "criteria",
  ]);
  const reports = inventory(value.reports, [
    "requestId",
    "version",
    "assignmentVersion",
    "authorId",
    "materialId",
    "evidence",
  ]);
  const acceptances = inventory(value.acceptances, [
    "requestId",
    "reportVersion",
    "requesterId",
    "acceptedAt",
    "receipt",
  ]);
  const messages = inventory(value.messages, [
    "seq",
    "senderId",
    "recipientId",
    "kind",
    "replyTo",
    "materialId",
    "requestId",
    "reportVersion",
    "createdAt",
  ]);
  const operations =
    Array.isArray(value.operations) &&
    value.operations.every((row) =>
      memoObject(
        row,
        ["projectId", "operationId", "fingerprint", "outcome"],
        lifecycle ? ["registrationAfterSeq"] : [],
      ),
    )
      ? value.operations
      : null;
  if (!materials || !requests || !reports || !acceptances || !messages || !operations) return false;

  const materialById = new Map<string, ExchangeMaterial>();
  for (const material of materials) {
    if (!validMaterial(material, members) || materialById.has(material.id)) return false;
    materialById.set(material.id, material);
  }
  const project = (id: unknown): id is string => isCanonicalUuid(id) && members.has(id);
  const requestById = new Map<string, Row>();
  for (const request of requests) {
    if (
      !isCanonicalUuid(request.id) ||
      requestById.has(request.id) ||
      !project(request.requesterId) ||
      !project(request.assigneeId) ||
      !exchangeCount(request.assignmentVersion, 1) ||
      !exchangeWorkflowText(request.condition, request.criteria)
    )
      return false;
    requestById.set(request.id, request);
  }
  const reportByKey = new Map<string, Row>();
  for (const report of reports) {
    const request = typeof report.requestId === "string" ? requestById.get(report.requestId) : undefined;
    const material = typeof report.materialId === "string" ? materialById.get(report.materialId) : undefined;
    const key = reportKey(report.requestId, report.version);
    if (
      !request ||
      !exchangeCount(report.version, 1) ||
      !exchangeCount(report.assignmentVersion, 1) ||
      (!lifecycle && request.assignmentVersion !== report.assignmentVersion) ||
      !project(report.authorId) ||
      (!lifecycle && report.authorId !== request.assigneeId) ||
      material?.kind !== "body" ||
      material.ownerProjectId !== report.authorId ||
      !Array.isArray(report.evidence) ||
      !report.evidence.every((id) => typeof id === "string" && materialById.has(id)) ||
      new Set(report.evidence).size !== report.evidence.length ||
      reportByKey.has(key)
    )
      return false;
    reportByKey.set(key, report);
  }
  const accepted = new Map<string, ExchangeAcceptanceReceipt>();
  for (const row of acceptances) {
    const key = reportKey(row.requestId, row.reportVersion);
    const request = typeof row.requestId === "string" ? requestById.get(row.requestId) : undefined;
    if (
      !reportByKey.has(key) ||
      !request ||
      accepted.has(key) ||
      (!lifecycle && row.requesterId !== request.requesterId) ||
      !project(row.requesterId) ||
      !isCanonicalUtcTimestamp(row.acceptedAt) ||
      !memoObject(row.receipt, ["operationId", "kind"]) ||
      !exchangeOperationId(row.receipt.operationId) ||
      (row.receipt.kind !== "accept" &&
        row.receipt.kind !== "send" &&
        row.receipt.kind !== "report" &&
        (!lifecycle || row.receipt.kind !== "vote"))
    ) {
      return false;
    }
    accepted.set(key, { operationId: row.receipt.operationId, kind: row.receipt.kind });
  }
  const messageBySeq = new Map<number, Row>();
  const requestMessages = new Set<string>();
  const reportMessages = new Set<string>();
  const currentReportVersions = new Map<string, number>();
  const acceptanceMessages = new Set<string>();
  const acceptanceBatches = new Map<string, AcceptanceBatch>();
  const primaryBodies = new Set<string>();
  const state = lifecycle ? exchangeLifecycleHead(lifecycle, 0) : undefined;
  let transitionIndex = 0;
  for (const message of [...messages].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    if (
      !exchangeCount(message.seq, 1) ||
      message.seq > value.lastSeq ||
      messageBySeq.has(message.seq) ||
      !project(message.senderId) ||
      (message.recipientId !== null && !project(message.recipientId)) ||
      !isCanonicalUtcTimestamp(message.createdAt) ||
      (message.replyTo !== null && (!exchangeCount(message.replyTo, 1) || !messageBySeq.has(message.replyTo)))
    )
      return false;
    if (state && lifecycle) {
      while (transitionIndex < lifecycle.transitions.length) {
        const record = lifecycle.transitions[transitionIndex];
        if (!record || record.seq >= message.seq) break;
        applyExchangeTransition(state, record.actorId, record.transition);
        transitionIndex++;
      }
      if (
        state.state !== "active" ||
        !state.members.has(String(message.senderId)) ||
        (message.recipientId !== null && !state.members.has(String(message.recipientId)))
      )
        return false;
    }
    const request = typeof message.requestId === "string" ? requestById.get(message.requestId) : undefined;
    const ownership = request ? state?.ownership.get(String(request.id)) : undefined;
    const material = typeof message.materialId === "string" ? materialById.get(message.materialId) : undefined;
    const key = reportKey(message.requestId, message.reportVersion);
    if (EXCHANGE_INFORMATION_KINDS.some((kind) => kind === message.kind)) {
      if (
        message.requestId !== null ||
        message.reportVersion !== null ||
        material?.kind !== "body" ||
        material.ownerProjectId !== message.senderId
      )
        return false;
    } else if (message.kind === "request") {
      if (
        !request ||
        typeof message.requestId !== "string" ||
        requestMessages.has(message.requestId) ||
        message.senderId !== request.requesterId ||
        message.recipientId !== request.assigneeId ||
        message.materialId !== null ||
        message.reportVersion !== null
      )
        return false;
      requestMessages.add(message.requestId);
    } else if (message.kind === "report") {
      const report = reportByKey.get(key);
      if (
        !report ||
        !request ||
        typeof message.requestId !== "string" ||
        !exchangeCount(message.reportVersion, 1) ||
        !requestMessages.has(message.requestId) ||
        reportMessages.has(key) ||
        message.reportVersion <= (currentReportVersions.get(message.requestId) ?? 0) ||
        report.materialId !== message.materialId ||
        report.authorId !== message.senderId ||
        message.recipientId !== (ownership ? ownership.acceptanceOwnerId : request.requesterId) ||
        report.authorId !== (ownership ? ownership.assignedProjectId : request.assigneeId) ||
        report.assignmentVersion !== (ownership?.assignmentVersion ?? request.assignmentVersion) ||
        ownership?.disposition
      )
        return false;
      reportMessages.add(key);
      currentReportVersions.set(message.requestId, message.reportVersion);
    } else if (message.kind === "accept") {
      const receipt = accepted.get(key);
      if (
        !request ||
        typeof message.requestId !== "string" ||
        !receipt ||
        currentReportVersions.get(message.requestId) !== message.reportVersion ||
        acceptanceMessages.has(key) ||
        message.senderId !== (ownership ? ownership.acceptanceOwnerId : request.requesterId) ||
        ownership?.disposition ||
        reportByKey.get(key)?.assignmentVersion !== (ownership?.assignmentVersion ?? request.assignmentVersion) ||
        acceptances.find((entry) => reportKey(entry.requestId, entry.reportVersion) === key)?.requesterId !==
          message.senderId ||
        message.recipientId !== null ||
        message.materialId !== null
      )
        return false;
      acceptanceMessages.add(key);
      const owner = JSON.stringify([message.senderId, receipt.operationId]);
      const batch = acceptanceBatches.get(owner);
      if (batch) {
        if (
          batch.kind !== receipt.kind ||
          batch.lastRequestId >= message.requestId ||
          batch.sequences.at(-1) !== message.seq - 1
        )
          return false;
        batch.sequences.push(message.seq);
        batch.lastRequestId = message.requestId;
      } else {
        acceptanceBatches.set(owner, {
          kind: receipt.kind,
          sequences: [message.seq],
          lastRequestId: message.requestId,
        });
      }
    } else return false;
    if (material?.kind === "body") {
      if (primaryBodies.has(material.id)) return false;
      primaryBodies.add(material.id);
    }
    messageBySeq.set(message.seq, message);
  }
  if (
    requestMessages.size !== requestById.size ||
    reportMessages.size !== reportByKey.size ||
    acceptanceMessages.size !== accepted.size
  )
    return false;
  const operationIds = new Set<string>();
  const recordedSeqs = new Set<number>();
  const recordedMaterials = new Set<string>();
  const transitionReceipts = new Map<string, ExchangeTransitionRecord>();
  for (const record of lifecycle?.transitions ?? []) {
    const key = JSON.stringify([record.actorId, record.operationId]);
    if (transitionReceipts.has(key)) return false;
    transitionReceipts.set(key, record);
  }
  for (const operation of operations) {
    const key = JSON.stringify([operation.projectId, operation.operationId]);
    const record = transitionReceipts.get(key);
    if (
      !project(operation.projectId) ||
      !exchangeOperationId(operation.operationId) ||
      !digest(operation.fingerprint) ||
      (record
        ? canonicalJson(operation.outcome) !==
          canonicalJson(exchangeControlOutcome(exchangeId, record.seq, record.transition))
        : validExchangeNoticeOutcome(operation.outcome)
          ? !noticeOutcomes ||
            operation.outcome.exchangeId !== exchangeId ||
            operation.outcome.projectId !== operation.projectId ||
            !project(operation.outcome.affectedProjectId) ||
            operation.fingerprint !== exchangeNoticeAckFingerprint(operation.outcome.incidentId)
          : !validOutcome(operation.outcome, exchangeId, operation.projectId, messageBySeq, materialById, requestById))
    )
      return false;
    if (operationIds.has(key)) return false;
    operationIds.add(key);
    // Standalone and bundled effects share the receipt's original actor and operation ID.
    const outcome = operation.outcome as RetainedExchangeOperation["outcome"];
    if (
      lifecycle &&
      (outcome.kind === "material-register"
        ? !exchangeCount(operation.registrationAfterSeq) || operation.registrationAfterSeq > value.lastSeq
        : Object.hasOwn(operation, "registrationAfterSeq"))
    )
      return false;
    const batch = acceptanceBatches.get(key);
    if (batch && batch.kind !== outcome.kind) return false;
    if (outcome.kind === "notice-ack") continue;
    if (record) {
      if (record.transition.kind === "vote") {
        const sequences = batch?.sequences ?? [];
        if (
          canonicalJson(sequences) !== canonicalJson(record.transition.acceptanceSequences) ||
          (sequences.length > 0 && sequences.at(-1) !== record.seq - 1)
        )
          return false;
        for (const seq of sequences) {
          if (recordedSeqs.has(seq)) return false;
          recordedSeqs.add(seq);
        }
      } else if (batch) return false;
      acceptanceBatches.delete(key);
      transitionReceipts.delete(key);
      continue;
    }
    if (outcome.kind === "material-register") {
      if (recordedMaterials.has(outcome.materialId)) return false;
      recordedMaterials.add(outcome.materialId);
    } else {
      let sequences: number[];
      if (outcome.kind === "accept") {
        if (
          !batch ||
          outcome.sequences.length !== batch.sequences.length ||
          outcome.sequences.some((seq, index) => seq !== batch.sequences[index])
        )
          return false;
        sequences = batch.sequences;
      } else {
        if (batch && batch.sequences.at(-1) !== outcome.seq - 1) return false;
        if (!("seq" in outcome)) return false;
        sequences = [...(batch?.sequences ?? []), outcome.seq];
      }
      for (const seq of sequences) {
        if (recordedSeqs.has(seq)) return false;
        recordedSeqs.add(seq);
      }
    }
    acceptanceBatches.delete(key);
  }
  return (
    acceptanceBatches.size === 0 &&
    transitionReceipts.size === 0 &&
    messageBySeq.size === recordedSeqs.size &&
    [...materialById].every(([id, material]) =>
      material.kind === "body" ? primaryBodies.has(id) : recordedMaterials.has(id),
    )
  );
}
