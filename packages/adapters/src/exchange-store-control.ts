import {
  acceptExchangeReports,
  type ExchangeActionData,
  type ExchangeControlInput,
  exchangeControlOutcome,
  exchangeRequiresParticipantClaim,
  type ExchangeTransition,
  exchangeTransitionChangesWork,
  planExchangeControl,
  requireExchangeClaim,
} from "@sorage/core";
import { exchangeMaterial } from "./exchange-collaboration-records";
import {
  conflict,
  denied,
  type ExchangeStoreInternals,
  invalid,
  need,
  type RevalidationCapture,
  sameActor,
} from "./exchange-context";
import { recordExchangeTransition } from "./exchange-lifecycle-records";

export function normalizeExchangeControl(
  store: ExchangeStoreInternals,
  input: ExchangeControlInput,
): ExchangeControlInput {
  const target = (reference: string | undefined): string | undefined => {
    if (reference === undefined) return;
    // Historical fingerprints remain resolvable after a Project is archived.
    const project = need(store.project(reference));
    return project?.id ?? invalid("A named Project is not registered.");
  };
  const requests = <T extends { requestId: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => a.requestId.localeCompare(b.requestId));
  switch (input.kind) {
    case "roster":
      return {
        ...input,
        pauseVersion: input.pauseVersion ?? 0,
        add: input.add.map((id) => target(id) as string).sort(),
        remove: input.remove.map((id) => target(id) as string).sort(),
      };
    case "owner-correct":
      return {
        ...input,
        pauseVersion: input.pauseVersion ?? 0,
        acceptanceOwner: target(input.acceptanceOwner),
        assignee: target(input.assignee),
      };
    case "stop":
      return { ...input, pauseVersion: input.pauseVersion ?? 0 };
    case "request-disposition":
      return { ...input, followUp: target(input.followUp) };
    case "propose":
      return { ...input, report: requests(input.report), disposition: requests(input.disposition) };
    case "vote":
      return { ...input, accept: requests(input.accept) };
    default:
      return input;
  }
}

export function admitExchangeControl(store: ExchangeStoreInternals, input: ExchangeControlInput): ExchangeTransition {
  const header = store.access(input.exchangeId);
  const head = store.head(input.exchangeId);
  if (exchangeRequiresParticipantClaim(input.kind)) {
    if (head.state !== "active") conflict("This operation requires an Active Exchange.");
    need(requireExchangeClaim(store.claim(input.exchangeId), input.claim, store.now()));
  }
  const targets =
    input.kind === "roster"
      ? input.add
      : input.kind === "owner-correct"
        ? [input.acceptanceOwner, input.assignee]
        : input.kind === "request-disposition"
          ? [input.followUp]
          : [];
  for (const target of targets) {
    if (target !== undefined && need(store.project(target))?.status !== "active")
      invalid("A current responsibility must name an active Project.");
  }
  return need(
    planExchangeControl(
      input,
      head,
      store.actorId,
      JSON.parse(header.criteria),
      store.observedRequests(input.exchangeId, head),
    ),
  );
}

export function findRevalidationMaterial(store: ExchangeStoreInternals, exchangeId: string, id: string) {
  const material = exchangeMaterial(store.db, exchangeId, id);
  if (
    !material ||
    material.ownerProjectId !== store.actorId ||
    (material.kind !== "live" && material.kind !== "versioned")
  )
    return denied();
  return material;
}

export function runExchangeControl(
  store: ExchangeStoreInternals,
  input: ExchangeControlInput,
  fingerprint: string,
  captured?: RevalidationCapture,
): ExchangeActionData {
  const { exchangeId } = input;
  const transition = admitExchangeControl(store, input);
  const workRevision = store.head(exchangeId).workRevision;
  if (input.kind === "resume") store.checkJoinOwner(exchangeId);
  store.context.onFreshWrite?.();
  if (transition.kind === "vote" && input.kind === "vote") {
    transition.acceptanceSequences = need(
      acceptExchangeReports(store, exchangeId, input.accept, { kind: "vote", operationId: input.operationId }),
    );
  }
  if (transition.kind === "roster") {
    for (const project of transition.remove) {
      store.db.prepare("DELETE FROM exchange_claims WHERE exchange_id = ? AND project_id = ?").run(exchangeId, project);
      store.db
        .prepare("UPDATE exchange_members SET active = 0 WHERE exchange_id = ? AND project_id = ?")
        .run(exchangeId, project);
    }
    for (const project of transition.add) {
      store.db
        .prepare(`INSERT INTO exchange_members (exchange_id,project_id,active,initial) VALUES (?,?,1,0)
          ON CONFLICT(exchange_id,project_id) DO UPDATE SET active = 1`)
        .run(exchangeId, project);
    }
  }
  if (
    transition.kind === "pause" ||
    transition.kind === "stop" ||
    (transition.kind === "vote" && transition.completed)
  ) {
    store.db.prepare("DELETE FROM exchange_claims WHERE exchange_id = ?").run(exchangeId);
    store.db.prepare("DELETE FROM exchange_notice_claims WHERE exchange_id = ?").run(exchangeId);
    store.db.prepare("DELETE FROM exchange_notice_issues WHERE exchange_id = ?").run(exchangeId);
  }
  if (transition.kind === "vote" && transition.completed) {
    store.db.prepare("DELETE FROM exchange_read_ranges WHERE exchange_id = ?").run(exchangeId);
    store.db
      .prepare("UPDATE exchange_materials SET retired = 1 WHERE exchange_id = ? AND kind IN ('body','copy')")
      .run(exchangeId);
    store.db.prepare("INSERT INTO exchange_cleanup_intents (exchange_id) VALUES (?)").run(exchangeId);
    store.db
      .prepare(`INSERT INTO exchange_cleanup_items (exchange_id,content_id)
        SELECT DISTINCT exchange_id, content_id FROM exchange_materials WHERE exchange_id = ? AND retired = 1 AND content_id IS NOT NULL`)
      .run(exchangeId);
  }
  if (transition.kind === "material-revalidate") {
    const material = findRevalidationMaterial(store, exchangeId, transition.materialId);
    if (
      !captured ||
      !sameActor(store.actor, captured.actor) ||
      JSON.stringify(material) !== JSON.stringify(captured.material)
    )
      return conflict("The material custody changed before revalidation.");
    store.db
      .prepare("UPDATE exchange_materials SET scope_json = ?, available = 1 WHERE exchange_id = ? AND id = ?")
      .run(JSON.stringify(captured.custody), exchangeId, transition.materialId);
  }
  if (exchangeTransitionChangesWork(transition)) store.advanceWork(exchangeId);
  const seq = store.seq(exchangeId);
  const observedAt = store.now();
  const noticeTiming =
    transition.kind === "roster" || transition.kind === "owner-correct" || transition.kind === "resume";
  recordExchangeTransition(store.db, exchangeId, {
    seq,
    workRevision,
    actorId: store.actorId,
    operationId: input.operationId,
    transition,
    ...(noticeTiming ? { recordedAt: observedAt.toISOString() } : {}),
  });
  const outcome = exchangeControlOutcome(exchangeId, seq, transition);
  store.saveOutcome(outcome, input.operationId, fingerprint);
  if (transition.kind === "resume") {
    const claim = store.acquireClaim(exchangeId, observedAt);
    store.requireLiveOwner();
    return { ...store.publicView(exchangeId), ...claim, replayed: false };
  }
  return store.outcomeData(outcome, false);
}
