import {
  type AppError,
  appError,
  channelError,
  err,
  type HandoffDetailReadPorts,
  type HandoffReadPorts,
  isRetryableWaitListingFailure,
  type ListQuery,
  listChannelMessages,
  type MessageView,
  ok,
  type ReadActorInput,
  type Result,
  SystemClock,
  type WaitedInbox,
  waitForChannelMessages,
  waitForNewInboxItems,
} from "@sorage/core";
import { channelStorageError, createNodeChannelPorts, type NodeChannelPorts } from "./channel-command-ports";
import { createNodeHandoffReadPorts } from "./handoff-command-ports";
import { type CoveredReadStorage, openCoveredReadStorage } from "./read-storage";
import { blockingSleepMs } from "./sleep";
import { asSchemaAdmission } from "./sqlite/migrator";
import { asAppCommandError } from "./storage-contention";

function thrownHandoffReadError(error: unknown): AppError {
  return (
    asSchemaAdmission(error) ??
    asAppCommandError(error)?.error ??
    appError("INTERNAL_ERROR", `The read failed: ${error instanceof Error ? error.message : String(error)}`)
  );
}

function thrownChannelReadError(error: unknown): AppError {
  return channelError(channelStorageError(error));
}

export interface HandoffInboxWaitInput {
  actorInput: ReadActorInput;
  buildQuery: () => Result<ListQuery, AppError>;
  intervalSeconds: number;
  timeoutSeconds: number;
}

/**
 * Storage orchestration for `sorage inbox --wait` (RDR-001, RDR-002, CLI-020):
 * opens one covered-read handle for startup admission, query validation, and the
 * first poll iteration, then releases it before any sleep and opens one handle
 * per subsequent poll so no idle outer handle pins WAL checkpoints.
 */
export function runHandoffInboxWait(input: HandoffInboxWaitInput): Result<WaitedInbox, AppError> {
  let initialStorage: CoveredReadStorage | null = null;
  let initialReadPorts: HandoffDetailReadPorts | null = null;
  let queryValue: ListQuery | null = null;
  try {
    let opened: Result<CoveredReadStorage, AppError>;
    try {
      opened = openCoveredReadStorage({ surface: "handoff" });
    } catch (error) {
      opened = err(thrownHandoffReadError(error));
    }
    if (!opened.ok) return opened;
    initialStorage = opened.value;
    initialReadPorts = createNodeHandoffReadPorts({ database: initialStorage.db });
    const query = input.buildQuery();
    if (!query.ok) return query;
    queryValue = query.value;
  } catch (error) {
    return err(thrownHandoffReadError(error));
  } finally {
    if (queryValue === null && initialStorage !== null) {
      initialStorage.close();
      initialStorage = null;
    }
  }
  const waitClockPorts = initialReadPorts;
  const withPollPorts = <T>(body: (pollPorts: HandoffReadPorts) => Result<T, AppError>): Result<T, AppError> => {
    if (initialStorage !== null && initialReadPorts !== null) {
      const storage = initialStorage;
      const pollPorts = initialReadPorts;
      initialStorage = null;
      initialReadPorts = null;
      try {
        return body(pollPorts);
      } catch (error) {
        return err(thrownHandoffReadError(error));
      } finally {
        storage.close();
      }
    }
    let storage: Result<CoveredReadStorage, AppError>;
    try {
      storage = openCoveredReadStorage({ surface: "handoff" });
    } catch (error) {
      storage = err(thrownHandoffReadError(error));
    }
    if (!storage.ok) return err(storage.error);
    try {
      return body(createNodeHandoffReadPorts({ database: storage.value.db }));
    } catch (error) {
      return err(thrownHandoffReadError(error));
    } finally {
      storage.value.close();
    }
  };
  try {
    return waitForNewInboxItems(waitClockPorts, input.actorInput, queryValue, {
      intervalSeconds: input.intervalSeconds,
      timeoutSeconds: input.timeoutSeconds,
      sleepMs: blockingSleepMs,
      withPollPorts,
    });
  } catch (error) {
    return err(thrownHandoffReadError(error));
  } finally {
    if (initialStorage !== null) {
      initialStorage.close();
      initialStorage = null;
    }
  }
}

export interface ChannelMessagesWaitInput {
  listing: {
    channelRef: string;
    after?: unknown;
    from?: unknown;
    kind?: unknown;
    limit?: unknown;
  };
  intervalSeconds: number;
  timeoutSeconds: number;
}

/**
 * Storage orchestration for `sorage channel messages --wait` (CHN-007, RDR-005):
 * Vault and pause admission run once at the start on the first poll, and later
 * polls re-admit storage without Vault admission and without re-validating `--from`.
 */
export function runChannelMessagesWait(input: ChannelMessagesWaitInput): ReturnType<typeof waitForChannelMessages> {
  const clock = new SystemClock();
  const deadlineAt = clock.now().getTime() + input.timeoutSeconds * 1000;
  const listing = input.listing;

  let start: Result<CoveredReadStorage, AppError>;
  try {
    start = openCoveredReadStorage({ surface: "channel", vaultAdmission: true });
  } catch (error) {
    start = err(thrownChannelReadError(error));
  }
  if (!start.ok) return start;

  let first: Result<MessageView[], AppError>;
  let startPorts: NodeChannelPorts | undefined;
  try {
    startPorts = createNodeChannelPorts({ database: start.value.db });
    const validated = listChannelMessages(startPorts, listing);
    first = validated.ok ? ok(validated.value.items) : validated;
  } catch (error) {
    first = err(thrownChannelReadError(error));
  } finally {
    try {
      startPorts?.close();
    } catch {
      // The storage close below owns the injected connection.
    }
    start.value.close();
  }
  if (!first.ok && !isRetryableWaitListingFailure(first.error)) return err(channelError(first.error));

  let filterValidated = first.ok;
  let startListing: Result<MessageView[], AppError> | null = first;
  const poll = (): Result<MessageView[], AppError> => {
    if (startListing !== null) {
      const result = startListing;
      startListing = null;
      return result;
    }
    let storage: Result<CoveredReadStorage, AppError>;
    try {
      storage = openCoveredReadStorage({ surface: "channel" });
    } catch (error) {
      storage = err(thrownChannelReadError(error));
    }
    if (!storage.ok) return storage;
    let ports: NodeChannelPorts | undefined;
    try {
      ports = createNodeChannelPorts({ database: storage.value.db });
      if (!filterValidated) {
        const listed = listChannelMessages(ports, listing);
        if (!listed.ok) return listed;
        filterValidated = true;
        return ok(listed.value.items);
      }
      const listed = listChannelMessages(ports, { ...listing, fromAlreadyValidated: true });
      return listed.ok ? ok(listed.value.items) : listed;
    } catch (error) {
      return err(thrownChannelReadError(error));
    } finally {
      try {
        ports?.close();
      } catch {
        // The storage close below owns the injected connection.
      }
      storage.value.close();
    }
  };

  const waited = waitForChannelMessages({
    intervalSeconds: input.intervalSeconds,
    deadlineAt,
    clock,
    sleepMs: blockingSleepMs,
    poll,
  });
  if (!waited.ok) return err(channelError(waited.error));
  return waited;
}
