import { type AppError, appError, err, type Result } from "../shared/errors";
import { type ChannelRecord, isChannelUuid } from "./channel-model";

/** Internal cross-file Channel lookup contract; structurally compatible with ChannelReader/ChannelTransaction. */
export interface ChannelRefReader {
  channelByName(name: string): Result<ChannelRecord | null, AppError>;
  channelById(id: string): Result<ChannelRecord | null, AppError>;
}

export function invalid(message: string): Result<never> {
  return err(appError("CHN_INVALID_INPUT", message));
}

/** Resolves a `<channel>` argument: a UUID-shaped reference addresses the id, every other string the name (CHN-002). */
export function resolveChannel(reader: ChannelRefReader, reference: string): Result<ChannelRecord | null, AppError> {
  return isChannelUuid(reference) ? reader.channelById(reference) : reader.channelByName(reference);
}

export function channelNotFound(reference: string): Result<never> {
  return err(appError("CHN_NOT_FOUND", `Unknown Channel name or UUID: ${reference}`));
}
