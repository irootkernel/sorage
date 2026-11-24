import {
  err,
  exchangeAccessDenied,
  type ExchangeActionData,
  type ExchangeActionFor,
  type ExchangeInput,
  exchangeInvalid,
  type ExchangeLifecycleInput,
  isCanonicalUuid,
  ok,
  type Result,
  runExchangeCommand,
} from "@sorage/core";
import { readCheckpoint, readSnapshot } from "./exchange-checkpoints";
import {
  contextOf,
  type ExchangeCommandOptions,
  type ExchangeJoinAdmission,
  openExchangeWriter,
  type Preparation,
  storageFailure,
} from "./exchange-context";
import { writeExchange } from "./exchange-write";

export { contentionKindOf } from "./storage-contention";
export type { ExchangeCommandOptions, ExchangeJoinAdmission } from "./exchange-context";

/** Resolve the gated MCP child's exact authority before it asks to enter the join queue. */
export function admitExchangeJoin(
  input: Extract<ExchangeLifecycleInput, { kind: "join" }>,
  options: ExchangeCommandOptions,
): Result<ExchangeJoinAdmission> {
  try {
    if (options.asUser === true) return err(exchangeAccessDenied());
    if (!isCanonicalUuid(input.exchangeId)) return err(exchangeInvalid("Supply an Exchange UUID."));
    const context = contextOf(options);
    if (!context.ok) return context;
    const resolve = () =>
      readSnapshot(context.value, (store) => {
        store.access(input.exchangeId);
        return ok({ exchangeId: input.exchangeId, projectId: store.actorId, actor: store.actor });
      });
    const first = resolve();
    if (first.ok || first.error.code !== "STORAGE_MIGRATION_REQUIRED" || input.resume?.replayOnly) return first;
    const writer = openExchangeWriter(context.value);
    if (!writer.ok) return writer;
    writer.value.close();
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
    if (!context.ok) return context;
    const preparation: Preparation = {};
    return runExchangeCommand(
      {
        inspect: (request) => readCheckpoint(context.value, request, preparation),
        executeFresh: (request, fingerprint) => writeExchange(context.value, request, fingerprint, preparation),
      },
      input,
    );
  } catch (error) {
    return err(storageFailure(error));
  }
}
