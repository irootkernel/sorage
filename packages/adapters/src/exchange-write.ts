import {
  type AppError,
  appError,
  commitExchangeBusiness,
  currentExchangeProposal,
  err,
  exchangeAcceptanceChangesWork,
  exchangeAccessDenied,
  type ExchangeActionData,
  type ExchangeActivationWarning,
  type ExchangeBusinessInput,
  type ExchangeControlInput,
  exchangeInvalid,
  type ExchangeLifecycleInput,
  type ExchangeNoticeAckInput,
  exchangeNoticeAckFingerprint,
  isExchangeBusiness,
  isExchangeControl,
  matchExchangeFingerprint,
  ok,
  planExchangeBusiness,
  type Result,
} from "@sorage/core";
import { readCheckpoint } from "./exchange-checkpoints";
import {
  type Context,
  controlFingerprint,
  controlOf,
  createWorkingStore,
  observeWorkspace,
  openExchangeWriter,
  type Preparation,
  sameActor,
  storageFailure,
} from "./exchange-context";
import { ExchangeStore } from "./exchange-store";
import type { PreparedExchangeBody } from "./exchange-working-store";
import { runInTransaction } from "./sqlite/transaction";

function activationWarning(error: AppError): ExchangeActivationWarning {
  return {
    code: error.code,
    message: error.message,
    recovery: {
      suggestedCommand: "Run an authorized Exchange write or join for this Exchange to retry pending material",
    },
  };
}

export function writeExchange(
  context: Context,
  input: ExchangeBusinessInput | ExchangeLifecycleInput | ExchangeControlInput | ExchangeNoticeAckInput,
  fingerprint: string | undefined,
  preparation: Preparation,
): Result<ExchangeActionData, AppError> {
  const opened = openExchangeWriter(context);
  if (!opened.ok) return opened;
  const db = opened.value;
  const working = createWorkingStore(db, context);
  let prepared: PreparedExchangeBody | undefined;
  let commitAttempted = false;
  let fresh = false;
  const admit = () => {
    if (!fresh) context.onFreshWrite?.();
    fresh = true;
  };
  try {
    const control = controlOf(input);
    if (
      (isExchangeBusiness(input) && preparation.captured === undefined) ||
      ((control !== undefined || input.kind === "notice-ack") && fingerprint === undefined)
    ) {
      // The read admission may have required a known older schema to be migrated first.
      const observed = readCheckpoint(context, input, preparation);
      if (!observed.ok) return observed;
      if (observed.value.data !== undefined) return ok(observed.value.data);
      fingerprint = observed.value.fingerprint;
    }
    const captured = preparation.captured;
    if (captured?.content && "exchangeId" in input) {
      admit();
      const staged = captured.content.prepare(working, input.exchangeId);
      if (!staged.ok) return staged;
      prepared = staged.value;
    }
    const workspace = observeWorkspace(context);
    const committed = runInTransaction<{
      data: ExchangeActionData | undefined;
      exchangeId: string;
      fresh: boolean;
      completed?: boolean;
    }>(
      db,
      "BEGIN IMMEDIATE",
      () => {
        const store = new ExchangeStore(db, context, workspace, captured, prepared);
        if (input.kind === "notice-ack") {
          const observed = exchangeNoticeAckFingerprint(input.incidentId);
          const receipt = store.currentReceipt(input);
          if (receipt) {
            const matched = matchExchangeFingerprint(receipt.fingerprint, observed);
            if (!matched.ok) return matched;
            return ok({ data: store.outcomeData(receipt.outcome, true), exchangeId: input.exchangeId, fresh: false });
          }
          if (observed !== fingerprint)
            return err(appError("ROW_VERSION_CONFLICT", "The Exchange notice input changed during admission."));
          const data = store.acknowledgeNotice(input, observed);
          return ok({ data, exchangeId: input.exchangeId, fresh: false });
        }
        if (control !== undefined) {
          const receipt = store.currentReceipt(control);
          let normalized = store.normalizeControl(control);
          if (normalized.kind === "material-revalidate") {
            const source = preparation.revalidation;
            if (!source || !sameActor(store.actor, source.actor)) return err(exchangeAccessDenied());
            normalized = { ...normalized, source: source.custody.relativePath };
          }
          const observed = controlFingerprint(normalized);
          if (receipt) {
            const matched = matchExchangeFingerprint(receipt.fingerprint, observed);
            if (!matched.ok) return matched;
            return ok({ data: store.outcomeData(receipt.outcome, true), exchangeId: control.exchangeId, fresh: false });
          }
          if (observed !== fingerprint)
            return err(appError("ROW_VERSION_CONFLICT", "The normalized Exchange control changed during admission."));
          const data = store.runControl(normalized, observed, preparation.revalidation);
          return ok({ data, exchangeId: control.exchangeId, fresh: true });
        }
        if (isExchangeControl(input)) return err(exchangeInvalid("The Exchange control is unavailable."));
        if (input.kind === "cleanup") {
          store.access(input.exchangeId);
          return ok({
            data: undefined,
            exchangeId: input.exchangeId,
            fresh: false,
            completed: store.head(input.exchangeId).state === "completed",
          });
        }
        if (!isExchangeBusiness(input)) {
          const data = store.lifecycle(input);
          return ok({
            data,
            exchangeId: input.exchangeId,
            fresh: (input.kind === "join" && "claimId" in data) || ("changed" in data && data.changed),
          });
        }
        const receipt = store.currentReceipt(input);
        const plan = planExchangeBusiness(store, input, captured?.facts ?? {});
        if (!plan.ok) return plan;
        if (receipt) {
          const matched = matchExchangeFingerprint(receipt.fingerprint, plan.value.fingerprint);
          if (!matched.ok) return matched;
          return ok({
            data: store.outcomeData(receipt.outcome, true),
            fresh: false,
            exchangeId: receipt.outcome.exchangeId,
          });
        }
        if (fingerprint !== plan.value.fingerprint)
          return err(appError("ROW_VERSION_CONFLICT", "The normalized Exchange input changed during admission."));
        if (input.kind !== "create") store.requireActive(input.exchangeId);
        let changesWork = input.kind === "request" || input.kind === "report" || input.kind === "material-register";
        if ((input.kind === "accept" || input.kind === "send") && input.accept.length > 0) {
          const proposed = currentExchangeProposal(store.head(input.exchangeId));
          changesWork = exchangeAcceptanceChangesWork(input.accept, proposed);
        }
        const outcome = commitExchangeBusiness(store, input, plan.value, admit);
        if (!outcome.ok) return outcome;
        if (changesWork) store.advanceWork(outcome.value.exchangeId);
        const data = store.outcomeData(outcome.value, false);
        commitAttempted = true;
        return ok({ data, exchangeId: outcome.value.exchangeId, fresh: true });
      },
      { failure: storageFailure },
    );
    if (!committed.ok) {
      if (prepared && commitAttempted) working.discardAfterFailedCommit(prepared);
      return committed;
    }
    const { data, exchangeId } = committed.value;
    if (data === undefined) {
      context.onFreshWrite?.();
      return working.cleanup(exchangeId, committed.value.completed === true);
    }
    if (!committed.value.fresh) return ok(data);
    const warnings: ExchangeActivationWarning[] = [];
    const finished = prepared ? working.finish(prepared) : undefined;
    if (finished !== undefined) {
      if (!finished.ok) warnings.push(activationWarning(finished.error));
      else if ("replayed" in data) data.availability = "available";
    }
    const completed = "kind" in data && data.kind === "vote" && "state" in data && data.state === "completed";
    if (completed) {
      const cleanup = working.cleanup(exchangeId);
      if (!cleanup.ok) warnings.push(activationWarning(cleanup.error));
      if (cleanup.ok && cleanup.value.warnings) warnings.push(...cleanup.value.warnings);
      return ok({ ...data, ...(warnings.length ? { warnings } : {}) });
    }
    const recovered = working.recover(exchangeId, finished?.ok === false ? prepared?.id : undefined);
    for (const failure of recovered.ok ? recovered.value.failures : [recovered.error])
      warnings.push(activationWarning(failure));
    return ok(warnings.length === 0 ? data : { ...data, warnings });
  } catch (error) {
    return err(storageFailure(error));
  } finally {
    if (prepared && !commitAttempted) working.discard(prepared);
    try {
      db.close();
    } catch {
      /* An already committed operation keeps its durable outcome. */
    }
  }
}
