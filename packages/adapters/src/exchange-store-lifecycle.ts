import { randomUUID } from "node:crypto";
import {
  appError,
  authorizeExchangeJoin,
  EXCHANGE_LEASE_SECONDS,
  type ExchangeActionData,
  type ExchangeClaim,
  type ExchangeLeaseResult,
  type ExchangeLifecycleInput,
  normalizeExchangeRanges,
  requireExchangeClaim,
  unconfirmedExchangeRanges,
} from "@sorage/core";
import { denied, type ExchangeStoreInternals, fail, invalid, need, sameActor } from "./exchange-context";

export function requireLiveExchangeOwner(store: ExchangeStoreInternals): void {
  if (store.context.leaseOwnerAlive?.() === false)
    fail(appError("EXCHANGE_CLAIM_CONFLICT", "The Exchange lease owner is no longer live."));
}

export function checkExchangeJoinOwner(store: ExchangeStoreInternals, exchangeId: string): void {
  const admitted = store.context.joinAdmission;
  if (admitted && (admitted.exchangeId !== exchangeId || !sameActor(admitted.actor, store.actor))) denied();
  requireLiveExchangeOwner(store);
}

export function acquireExchangeClaim(store: ExchangeStoreInternals, exchangeId: string, now: Date): ExchangeClaim {
  const claimId = randomUUID();
  const expiresAt = new Date(now.getTime() + EXCHANGE_LEASE_SECONDS * 1_000).toISOString();
  const previous = store.claim(exchangeId);
  const continuous = previous !== null && Date.parse(previous.expiresAt) > now.getTime();
  const observedAt = now.toISOString();
  if (continuous) {
    store.db
      .prepare(`UPDATE exchange_notice_presence SET heartbeat_at = ?
        WHERE exchange_id = ? AND project_id = ?`)
      .run(observedAt, exchangeId, store.actorId);
  } else {
    store.db
      .prepare(`INSERT INTO exchange_notice_presence VALUES (?,?,?,?,?)
        ON CONFLICT(exchange_id,project_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,
          online_since=excluded.online_since, epoch=excluded.epoch`)
      .run(exchangeId, store.actorId, observedAt, observedAt, randomUUID());
    store.db
      .prepare(`DELETE FROM exchange_notice_issues WHERE exchange_id = ? AND affected_project_id = ?`)
      .run(exchangeId, store.actorId);
  }
  store.db
    .prepare(
      "INSERT INTO exchange_claims VALUES (?,?,?,?) ON CONFLICT(exchange_id,project_id) DO UPDATE SET claim_id=excluded.claim_id,expires_at=excluded.expires_at",
    )
    .run(exchangeId, store.actorId, claimId, expiresAt);
  return { claimId, expiresAt };
}

function maintainExchangeLease(
  store: ExchangeStoreInternals,
  input: Extract<ExchangeLifecycleInput, { kind: "renew" | "release" }>,
): ExchangeLeaseResult {
  const { exchangeId, claim: claimId } = input;
  requireLiveExchangeOwner(store);
  const persisted = store.claim(exchangeId);
  const now = store.now();
  const current = need(requireExchangeClaim(persisted, claimId, now));
  let expiresAt = current.expiresAt;
  store.context.onFreshWrite?.();
  if (input.kind === "renew") {
    expiresAt = new Date(now.getTime() + EXCHANGE_LEASE_SECONDS * 1_000).toISOString();
    store.db
      .prepare("UPDATE exchange_claims SET expires_at = ? WHERE exchange_id = ? AND project_id = ? AND claim_id = ?")
      .run(expiresAt, exchangeId, store.actorId, claimId);
    store.db
      .prepare("UPDATE exchange_notice_presence SET heartbeat_at = ? WHERE exchange_id = ? AND project_id = ?")
      .run(now.toISOString(), exchangeId, store.actorId);
  } else {
    store.db
      .prepare("DELETE FROM exchange_claims WHERE exchange_id = ? AND project_id = ? AND claim_id = ?")
      .run(exchangeId, store.actorId, claimId);
  }
  requireLiveExchangeOwner(store);
  return { exchangeId, projectId: store.actorId, claimId, expiresAt };
}

export function runExchangeLifecycle(
  store: ExchangeStoreInternals,
  input: Exclude<ExchangeLifecycleInput, { kind: "cleanup" }>,
): ExchangeActionData {
  const { exchangeId } = input;
  const header = store.access(exchangeId);
  if (input.kind === "join") {
    checkExchangeJoinOwner(store, exchangeId);
    const head = store.head(exchangeId);
    if (head.state !== "active") return store.view(header);
    const now = store.context.now();
    need(authorizeExchangeJoin(store.claim(exchangeId), input.replaceClaim, input.confirmed, now));
    store.context.onFreshWrite?.();
    const claim = acquireExchangeClaim(store, exchangeId, now);
    const view = store.view(header);
    requireLiveExchangeOwner(store);
    return { ...view, ...claim };
  }
  if (input.kind === "renew" || input.kind === "release") return maintainExchangeLease(store, input);
  if (input.kind === "notice-acquire") return store.acquireNotice(input, true);
  store.requireActive(exchangeId);
  need(requireExchangeClaim(store.claim(exchangeId), input.claim, store.now()));
  if (input.ranges.length === 0) return invalid("Confirm at least one exact delivered sequence or range.");
  const requested = need(normalizeExchangeRanges(input.ranges));
  const previous = store.ranges(exchangeId);
  const newlyConfirmed = unconfirmedExchangeRanges(requested, previous);
  for (const range of newlyConfirmed) {
    const row = store.db
      .prepare("SELECT COUNT(*) count FROM exchange_messages WHERE exchange_id = ? AND seq BETWEEN ? AND ?")
      .get(exchangeId, range.firstSeq, range.lastSeq) as { count: number } | undefined;
    if (row?.count !== range.lastSeq - range.firstSeq + 1)
      return invalid("Read confirmation crosses a sequence without a visible message.");
  }
  const changed = newlyConfirmed.length > 0;
  const readRanges = changed ? need(normalizeExchangeRanges([...previous, ...newlyConfirmed])) : previous;
  if (changed) {
    store.context.onFreshWrite?.();
    store.db
      .prepare("DELETE FROM exchange_read_ranges WHERE exchange_id = ? AND project_id = ?")
      .run(exchangeId, store.actorId);
    const insert = store.db.prepare("INSERT INTO exchange_read_ranges VALUES (?,?,?,?)");
    for (const range of readRanges) insert.run(exchangeId, store.actorId, range.firstSeq, range.lastSeq);
  }
  return { exchangeId, projectId: store.actorId, readRanges, changed };
}
