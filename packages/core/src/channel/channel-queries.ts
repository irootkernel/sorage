import { appError, err, ok, type Result } from "../shared/errors";
import { channelNotFound, invalid, resolveChannel } from "./channel-internal";
import {
  CHANNEL_LIST_MAX_LIMIT,
  type ChannelSummary,
  type ChannelView,
  type MessageKind,
  type MessageRecord,
  type MessageView,
} from "./channel-model";
import type { ChannelCommandPorts } from "./channel-ports";
import { validateChannelHandle } from "./channel-validation";
import { channelViewOf, messageViewOf } from "./channel-views";

export interface ListChannelsInput {
  state?: unknown;
}

/** Lists Channels with both identifiers (section 38.4): `--state` defaults to `all`, newest first, no cursor, no total promise. */
export function listChannels(
  ports: ChannelCommandPorts,
  input: ListChannelsInput = {},
): Result<{ items: ChannelSummary[] }> {
  const state = input.state === undefined ? "all" : input.state;
  if (state !== "open" && state !== "closed" && state !== "all") {
    return invalid("Channel list accepts --state open, closed or all");
  }
  const listed = ports.channels.read((reader) => reader.listChannels({ state }));
  if (!listed.ok) return listed;
  return ok({ items: listed.value });
}

export interface ShowChannelInput {
  channelRef: unknown;
}

/** Shows one Channel with its complete participant roster and counts, no message bodies (section 38.4). */
export function showChannel(ports: ChannelCommandPorts, input: ShowChannelInput): Result<{ channel: ChannelView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel show requires a Channel name or UUID");
  return ports.channels.read((reader): Result<{ channel: ChannelView }> => {
    const channel = resolveChannel(reader, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const roster = reader.participants(channel.value.id);
    if (!roster.ok) return roster;
    const counters = reader.counters(channel.value.id);
    if (!counters.ok) return counters;
    const view = channelViewOf(channel.value, roster.value, counters.value);
    if (!view.ok) return view;
    return ok({ channel: view.value });
  });
}

export interface ListMessagesInput {
  channelRef: unknown;
  all?: boolean;
  after?: unknown;
  from?: unknown;
  kind?: unknown;
  limit?: unknown;
  /**
   * Skip the `--from` roster validation. Reserved for a wait poll whose filter
   * was validated once at invocation (section 38.5); every ordinary listing
   * validates and refuses an unknown or removed handle at once.
   */
  fromAlreadyValidated?: boolean;
}

function boundedLimit(ports: ChannelCommandPorts, value: unknown): Result<number> {
  if (value === undefined || value === null) return ok(ports.defaultPageSize);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid("The --limit option is a positive integer");
  }
  if (value > CHANNEL_LIST_MAX_LIMIT) {
    return invalid(`The --limit option is at most ${String(CHANNEL_LIST_MAX_LIMIT)}`);
  }
  return ok(value);
}

/**
 * The complete-content listing (CHN-006, SHR-012): unhandled messages oldest
 * first by default, all messages with `--all`, full inline bodies with
 * `bodyPath` for materialized file-backed bodies and `bodyPending: true` for
 * an unactivated one, the `--after`, `--from` and `--kind` filters, and no
 * mutation. `--from` is validated against the Channel roster once and an
 * unknown or removed handle fails immediately with
 * `CHN_PARTICIPANT_NOT_FOUND` (section 38.4 line 1712).
 */
export function listChannelMessages(
  ports: ChannelCommandPorts,
  input: ListMessagesInput,
): Result<{ items: MessageView[] }> {
  if (typeof input.channelRef !== "string") return invalid("The messages listing requires a Channel name or UUID");
  const from = input.from === undefined || input.from === null ? null : validateChannelHandle(input.from);
  if (from !== null && !from.ok) return from;
  if (
    input.kind !== undefined &&
    input.kind !== null &&
    input.kind !== "report" &&
    input.kind !== "question" &&
    input.kind !== "relay_request"
  ) {
    return invalid("The --kind filter accepts report, question or relay_request");
  }
  const kind = input.kind === undefined || input.kind === null ? null : (input.kind as MessageKind);
  let afterSeq: number | null = null;
  if (input.after !== undefined && input.after !== null) {
    if (typeof input.after !== "number" || !Number.isSafeInteger(input.after) || input.after < 0) {
      return invalid("The --after option is a non-negative integer sequence number");
    }
    afterSeq = input.after;
  }
  const limit = boundedLimit(ports, input.limit);
  if (!limit.ok) return limit;
  const listed = ports.channels.read((reader): Result<MessageRecord[]> => {
    const channel = resolveChannel(reader, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    if (from?.ok && input.fromAlreadyValidated !== true) {
      const sender = reader.participant(channel.value.id, from.value);
      if (!sender.ok) return sender;
      if (sender.value === null || sender.value.removedAt !== null) {
        return err(
          appError(
            "CHN_PARTICIPANT_NOT_FOUND",
            `Unknown or removed --from handle on the Channel ${channel.value.name}: ${from.value}`,
            {
              channelId: channel.value.id,
              handle: from.value,
            },
          ),
        );
      }
    }
    return reader.pageMessages(
      channel.value.id,
      {
        handling: input.all === true ? "all" : "unhandled",
        afterSeq,
        fromHandle: from === null ? null : from.value,
        kind,
      },
      limit.value,
    );
  });
  if (!listed.ok) return listed;
  const items: MessageView[] = [];
  for (const record of listed.value) {
    const resolved = ports.bodies.resolveBody(record.content);
    if (!resolved.ok) return resolved;
    items.push(messageViewOf(record, resolved.value));
  }
  return ok({ items });
}
