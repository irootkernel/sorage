import {
  type AppError,
  appError,
  err,
  exchangeAccessDenied,
  type ExchangeControlInput,
  exchangeCount,
  type ExchangeInput,
  exchangeInvalid,
  exchangeNoticeAckFingerprint,
  exchangeOperationId,
  type ExchangeReadDecision,
  isExchangeBusiness,
  isExchangeRead,
  isLowercaseSha256,
  matchExchangeFingerprint,
  ok,
  planExchangeBusiness,
  requireExchangeClaim,
  type Result,
  waitForExchangeActivity,
} from "@sorage/core";
import { captureBusiness } from "./exchange-capture";
import {
  type BusinessCapture,
  type Context,
  controlFingerprint,
  controlOf,
  observeWorkspace,
  type Preparation,
  sameActor,
  storageFailure,
} from "./exchange-context";
import {
  type BoundExchangeSource,
  digestExchangeSource,
  exchangeSourceChunks,
  resolveExchangeSource,
  withExchangeSource,
} from "./exchange-sources";
import { ExchangeStore } from "./exchange-store";
import { openCoveredReadStorage } from "./read-storage";
import { blockingSleepMs } from "./sleep";
import { runInTransaction } from "./sqlite/transaction";

function unavailableReplayError(): AppError {
  return appError("EXCHANGE_REPLAY_UNAVAILABLE", "The original Exchange outcome is unknown.");
}

export function readSnapshot<T>(
  context: Context,
  read: (store: ExchangeStore) => Result<T, AppError>,
  captured?: BusinessCapture,
): Result<T, AppError> {
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
      () => read(new ExchangeStore(opened.value.db, context, workspace, captured)),
      { failure: storageFailure },
    );
  } finally {
    opened.value.close();
  }
}

function readControlCheckpoint(
  context: Context,
  input: ExchangeControlInput,
  preparation: Preparation,
): Result<ExchangeReadDecision, AppError> {
  if (input.kind === "material-revalidate") return readRevalidationCheckpoint(context, input, preparation);
  return readSnapshot(context, (store) => {
    const receipt = store.currentReceipt(input);
    if (!receipt && input.replayOnly) return err(unavailableReplayError());
    const normalized = store.normalizeControl(input);
    const fingerprint = controlFingerprint(normalized);
    if (receipt) {
      const matched = matchExchangeFingerprint(receipt.fingerprint, fingerprint);
      if (!matched.ok) return matched;
      return ok({ data: store.outcomeData(receipt.outcome, true), fingerprint });
    }
    store.admitControl(normalized);
    return ok({ fingerprint });
  });
}

function readRevalidationCheckpoint(
  context: Context,
  input: Extract<ExchangeControlInput, { kind: "material-revalidate" }>,
  preparation: Preparation,
): Result<ExchangeReadDecision, AppError> {
  const admitted = readSnapshot(context, (store) => {
    const receipt = store.currentReceipt(input);
    if (!receipt && input.replayOnly) return err(unavailableReplayError());
    if (!receipt) store.admitControl(input);
    return ok({ actor: store.actor, historical: receipt !== null });
  });
  if (!admitted.ok) return admitted;
  const { actor, historical } = admitted.value;
  // Resolve the relative identity from the current supplier binding without opening the source.
  let identity: BoundExchangeSource;
  try {
    identity = resolveExchangeSource(actor.binding, context.cwd, input.source, 0, null);
  } catch (error) {
    return err(storageFailure(error));
  }
  const fingerprint = controlFingerprint({ ...input, source: identity.relativePath });
  const read = readSnapshot<
    ExchangeReadDecision | { material: NonNullable<ReturnType<ExchangeStore["revalidationMaterial"]>> }
  >(context, (store) => {
    const receipt = store.currentReceipt(input);
    if (!sameActor(store.actor, actor)) return err(exchangeAccessDenied());
    if (receipt) {
      const matched = matchExchangeFingerprint(receipt.fingerprint, fingerprint);
      if (!matched.ok) return matched;
      return ok({ data: store.outcomeData(receipt.outcome, true) });
    }
    if (input.replayOnly || historical) return err(unavailableReplayError());
    store.admitControl(input);
    return ok({ material: store.revalidationMaterial(input.exchangeId, input.materialId) });
  });
  if (!read.ok) return read;
  if (!("material" in read.value)) return ok(read.value);
  const { material } = read.value;
  const previous = JSON.parse(material.source ?? "null") as BoundExchangeSource | null;
  if (!previous) return err(appError("CONTENT_CORRUPTED", "The local reference scope is missing."));
  const custody = { ...identity, offset: previous.offset, length: previous.length };
  if (previous.relativePath !== undefined && custody.relativePath !== previous.relativePath)
    return err(
      appError("EXCHANGE_MATERIAL_UNAVAILABLE", "Use the original confined reference path.", { reason: "changed" }),
    );
  try {
    const verified = withExchangeSource(
      custody,
      actor.binding,
      ({ fd, size, observedVersion }): Result<void, AppError> => {
        if (material.kind === "live") return ok(undefined);
        const proof = digestExchangeSource(
          exchangeSourceChunks(fd, custody.offset, size),
          context.config.artifact.maxBytes,
        );
        if (proof.sizeBytes !== material.sizeBytes || proof.sha256 !== material.sha256)
          return err(
            appError("EXCHANGE_MATERIAL_UNAVAILABLE", "The original version no longer matches.", { reason: "changed" }),
          );
        custody.observedVersion = observedVersion;
        return ok(undefined);
      },
    );
    if (!verified.ok) return verified;
  } catch (error) {
    return err(storageFailure(error));
  }
  preparation.revalidation = { material, actor, custody };
  return ok({ fingerprint });
}

export function readCheckpoint(
  context: Context,
  input: ExchangeInput,
  preparation: Preparation,
): Result<ExchangeReadDecision, AppError> {
  if (input.kind === "notice-ack") {
    if (!isLowercaseSha256(input.incidentId))
      return err(exchangeInvalid("Supply a current Exchange notice incident ID."));
    const fingerprint = exchangeNoticeAckFingerprint(input.incidentId);
    return readSnapshot<ExchangeReadDecision>(context, (store) => {
      const receipt = store.currentReceipt(input);
      if (receipt) {
        const matched = matchExchangeFingerprint(receipt.fingerprint, fingerprint);
        if (!matched.ok) return matched;
        return ok({ data: store.outcomeData(receipt.outcome, true) });
      }
      if (input.replayOnly) return err(unavailableReplayError());
      store.admitNoticeAck(input);
      return ok({ fingerprint });
    });
  }
  const control = controlOf(input);
  if (control !== undefined) {
    if (!exchangeOperationId(control.operationId))
      return err(exchangeInvalid("Supply a bounded operation ID for this Exchange control."));
    if (input.kind === "join" && input.replaceClaim !== undefined)
      return err(exchangeInvalid("Resumption and claim replacement are separate joins."));
    return readControlCheckpoint(context, control, preparation);
  }
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
      poll: (cursor) => readSnapshot(context, (store) => ok(store.waitPage(input.exchangeId, cursor, input.limit))),
    });
    return waited.ok ? ok({ data: waited.value }) : waited;
  }
  if (!isExchangeBusiness(input)) {
    const result = readSnapshot(context, (store) => {
      if (isExchangeRead(input)) return ok(store.read(input));
      if (input.kind === "notice-acquire") return ok(store.acquireNotice(input, false));
      store.access(input.exchangeId);
      if (input.kind === "join") {
        const state = store.head(input.exchangeId).state;
        if (state !== "active") return ok(store.publicView(input.exchangeId));
      }
      return ok(undefined);
    });
    if (!result.ok) return result;
    if (result.value === undefined) return ok({});
    try {
      return ok({ data: typeof result.value === "function" ? result.value() : result.value });
    } catch (error) {
      return err(storageFailure(error));
    }
  }
  // First authorize a capture. The second snapshot rechecks the current binding, access and receipt together.
  const observed = readSnapshot(context, (store) => {
    const receipt = store.currentReceipt(input);
    if (input.replayOnly && receipt === null) return err(unavailableReplayError());
    if (receipt === null && input.kind !== "create") {
      store.requireActive(input.exchangeId);
      const claimed = requireExchangeClaim(store.claim(input.exchangeId), input.claim, store.now());
      if (!claimed.ok) return claimed;
    }
    return ok({ actor: store.actor, historical: receipt !== null });
  });
  if (!observed.ok) return observed;
  const captured = captureBusiness(context, observed.value.actor, input, observed.value.historical);
  if (!captured.ok) return captured;
  return readSnapshot<ExchangeReadDecision>(
    context,
    (store) => {
      const receipt = store.currentReceipt(input);
      if (receipt === null && (input.replayOnly || observed.value.historical)) return err(unavailableReplayError());
      const plan = planExchangeBusiness(store, input, captured.value.facts);
      if (!plan.ok) return plan;
      if (receipt) {
        const matched = matchExchangeFingerprint(receipt.fingerprint, plan.value.fingerprint);
        if (!matched.ok) return matched;
        return ok({ data: store.outcomeData(receipt.outcome, true) });
      }
      if (input.kind !== "create") {
        store.requireActive(input.exchangeId);
        const claimed = requireExchangeClaim(store.claim(input.exchangeId), input.claim, store.now());
        if (!claimed.ok) return claimed;
      }
      preparation.captured = captured.value;
      return ok({ fingerprint: plan.value.fingerprint });
    },
    captured.value,
  );
}
