import {
  appError,
  currentExchangeProposal,
  encodeExchangeHistoryCursor,
  EXCHANGE_READ_BYTES,
  type ExchangeActionData,
  exchangeCount,
  exchangeFingerprint,
  type ExchangeHistoryCursor,
  type ExchangeMaterialPage,
  type ExchangeOutcome,
  exchangeProjection,
  type ExchangeReadInput,
  type ExchangeView,
  exchangeView,
  type ExchangeWaitPage,
  initialOwnership,
  isCanonicalUuid,
  readExchangeHistoryCursor,
} from "@sorage/core";
import {
  exchangeAcceptances,
  exchangeMaterial,
  exchangeMessages,
  exchangeOperations,
  exchangeReports,
  exchangeRequests,
  relevantExchangeMessages,
} from "./exchange-collaboration-records";
import { type ExchangeStoreInternals, fail, type Header, invalid, need } from "./exchange-context";
import { type BoundExchangeSource, readExchangeOriginal } from "./exchange-sources";

export function buildExchangeView(store: ExchangeStoreInternals, header: Header): ExchangeView {
  const { id: exchangeId, criteria, ...base } = header;
  const head = store.head(exchangeId);
  const current = exchangeView(
    { ...base, exchangeId, criteria: JSON.parse(criteria) },
    store.actorId,
    store.memberIds(exchangeId),
    exchangeRequests(store.db, exchangeId).map((request) => ({
      ...request,
      ownership: head.ownership.get(request.id) ?? initialOwnership(request),
    })),
    exchangeReports(store.db, exchangeId),
    exchangeAcceptances(store.db, exchangeId),
    head.state === "completed" ? [] : store.ranges(exchangeId),
  );
  const cleanup = store.db
    .prepare("SELECT failure FROM exchange_cleanup_intents WHERE exchange_id = ?")
    .get(exchangeId) as { failure: number } | undefined | null;
  const proposal = currentExchangeProposal(head);
  return {
    ...current,
    state: head.state,
    rosterVersion: head.rosterVersion,
    workRevision: head.workRevision,
    pauseVersion: head.pauseVersion,
    pause: head.pause,
    proposal,
    final: head.final,
    votes: proposal
      ? [...head.votes]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([projectId, vote]) => ({ projectId, ...vote }))
      : [],
    ...(head.state === "completed" ? { cleanup: !cleanup ? "complete" : cleanup.failure ? "failed" : "pending" } : {}),
  };
}

function historyCursor(store: ExchangeStoreInternals, header: Header, seq: number): ExchangeHistoryCursor {
  const head = store.head(header.id);
  const ownership = store
    .observedRequests(header.id, head)
    .filter(
      (row) =>
        row.ownership.version > 1 &&
        [
          row.ownership.acceptanceOwnerId,
          row.ownership.assignedProjectId,
          row.request.requesterId,
          row.request.assigneeId,
        ].includes(store.actorId),
    )
    .map((row) => [row.request.id, row.ownership.version]);
  const projection =
    head.state === "active" &&
    head.rosterVersion === 1 &&
    head.pauseVersion === 0 &&
    !head.proposal &&
    ownership.length === 0
      ? exchangeProjection("active", [...head.members])
      : exchangeFingerprint({
          state: head.state,
          rosterVersion: head.rosterVersion,
          pauseVersion: head.pauseVersion,
          proposal: currentExchangeProposal(head)?.version,
          ownership,
          members: [...head.members].sort(),
        });
  return {
    version: 1,
    exchangeId: header.id,
    projectId: store.actorId,
    seq,
    projection,
  };
}

export function readExchangeWaitPage(
  store: ExchangeStoreInternals,
  exchangeId: string,
  token?: string,
  requestedLimit?: number,
): ExchangeWaitPage {
  const header = store.access(exchangeId);
  const current = historyCursor(store, header, 0);
  const previous =
    token === undefined ? current : need(readExchangeHistoryCursor(token, exchangeId, store.actorId, header.lastSeq));
  const limit = requestedLimit ?? store.context.config.ui.defaultPageSize;
  if (!exchangeCount(limit, 1) || limit > 200) return invalid("Invalid history range.");
  const messages = relevantExchangeMessages(store.db, exchangeId, store.actorId, previous.seq, limit + 1);
  if (messages.length > limit) {
    messages.pop();
    current.seq = messages.at(-1)?.seq ?? previous.seq;
  } else {
    current.seq = header.lastSeq;
  }
  return {
    exchangeId,
    projectId: store.actorId,
    messages,
    cursor: encodeExchangeHistoryCursor(current),
    stateChanged: current.projection !== previous.projection,
  };
}

export function readExchangeData(
  store: ExchangeStoreInternals,
  input: ExchangeReadInput,
): ExchangeActionData | (() => ExchangeActionData) {
  if (input.kind === "recover") {
    if (input.exchangeId !== undefined) store.access(input.exchangeId);
    const create = store.db
      .prepare<{ operationId: string; exchangeId: string }>(
        `SELECT o.operation_id operationId, o.exchange_id exchangeId FROM exchange_creation_outcomes o
          JOIN exchange_members m ON m.exchange_id = o.exchange_id AND m.project_id = o.project_id
          WHERE o.project_id = ? AND m.active = 1 AND (? IS NULL OR o.exchange_id = ?) AND (? IS NULL OR o.operation_id = ?)
          ORDER BY o.operation_id`,
      )
      .all(
        store.actorId,
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
      for (const { operationId, outcome } of exchangeOperations(store.db, input.exchangeId, store.actorId)) {
        if (input.operationId === undefined || operationId === input.operationId)
          operations.push({ operationId, outcome });
      }
    }
    return { operations };
  }
  const header = store.access(input.exchangeId);
  if (input.kind === "inspect") return store.view(header);
  if (input.kind === "notice-list") return store.listNotices(header, input.claim);
  if (input.kind === "history") {
    const limit = input.limit ?? store.context.config.ui.defaultPageSize;
    if (input.cursor !== undefined && input.afterSeq !== undefined)
      return invalid("Use either a history cursor or an after sequence.");
    const previous =
      input.cursor === undefined
        ? undefined
        : need(readExchangeHistoryCursor(input.cursor, input.exchangeId, store.actorId, header.lastSeq));
    const after = previous?.seq ?? input.afterSeq ?? 0;
    if (!exchangeCount(after) || !exchangeCount(limit, 1) || limit > 200) return invalid("Invalid history range.");
    const messages = exchangeMessages(store.db, input.exchangeId, after, limit + 1);
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
      cursor: encodeExchangeHistoryCursor(previous ? { ...previous, seq } : historyCursor(store, header, seq)),
    };
  }
  if (input.kind === "wait") return invalid("Wait requires the Exchange polling path.");
  if (
    !isCanonicalUuid(input.materialId) ||
    !exchangeCount(input.offset) ||
    !exchangeCount(input.limit, 1) ||
    input.limit > EXCHANGE_READ_BYTES
  )
    return invalid("Invalid bounded Exchange material range.");
  const material = exchangeMaterial(store.db, input.exchangeId, input.materialId);
  if (!material || !material.available || material.retired)
    return fail(
      appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The registered Exchange material is unavailable.", {
        reason: material?.retired
          ? "retired"
          : material
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
    const read = need(store.working.planRead(input.exchangeId, material.contentId, input.offset, input.limit));
    return () => dataSlice({ ...material, kind }, input.offset, need(read()), sizeBytes);
  }
  const scope: BoundExchangeSource = JSON.parse(material.source ?? "null");
  const owner = store.db
    .prepare(
      `SELECT 1 FROM exchange_members m JOIN projects p ON p.id = m.project_id
        WHERE m.exchange_id = ? AND m.project_id = ? AND m.active = 1 AND p.status = 'active'`,
    )
    .get(input.exchangeId, material.ownerProjectId);
  if (!owner)
    return fail(
      appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The original supplier is no longer an active Exchange member.", {
        reason: "owner",
      }),
    );
  const bindings = need(store.projects.listBindingsForProject(material.ownerProjectId));
  const binding = bindings.find((entry) => entry.id === scope?.bindingId);
  if (!binding)
    return fail(
      appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The supplier's registered source binding is unavailable.", {
        reason: "binding",
      }),
    );
  const { kind } = material;
  return () => {
    const source = readExchangeOriginal(scope, binding, input.offset, input.limit, material.sha256, material.sizeBytes);
    return {
      ...dataSlice({ ...material, kind }, input.offset, source.bytes, source.size),
      observedVersion: source.observedVersion,
      ownerProjectId: material.ownerProjectId,
    };
  };
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
