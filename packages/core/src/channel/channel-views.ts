import { appError, err, ok, type Result } from "../shared/errors";
import type {
  ChannelRecord,
  ChannelSummary,
  ChannelView,
  MessageRecord,
  MessageView,
  ParticipantRecord,
  ParticipantView,
} from "./channel-model";
import type { ChannelCounters, ResolvedMessageBody } from "./channel-ports";

// ---------------------------------------------------------------------------
// View builders

/** Numeric code-point comparison, the shard's deterministic handle order (section 38.8).
 * UTF-16 unit comparison would sort U+10000 before U+E000; code points do not. */
export function compareHandles(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const first = (a[index] ?? "").codePointAt(0) ?? 0;
    const second = (b[index] ?? "").codePointAt(0) ?? 0;
    if (first < second) return -1;
    if (first > second) return 1;
  }
  return a.length - b.length;
}

export function participantViewOf(participant: ParticipantRecord): ParticipantView {
  return {
    handle: participant.handle,
    role: participant.role,
    addedAt: participant.addedAt,
    removedAt: participant.removedAt,
  };
}

export function channelSummaryOf(channel: ChannelRecord, mainHandle: string): ChannelSummary {
  return {
    id: channel.id,
    name: channel.name,
    title: channel.title,
    state: channel.state,
    main: mainHandle,
    createdAt: channel.createdAt,
    closedAt: channel.closedAt,
  };
}

export function channelViewOf(
  channel: ChannelRecord,
  participants: ParticipantRecord[],
  counters: ChannelCounters,
): Result<ChannelView> {
  const main = participants.find((participant) => participant.role === "main");
  if (main === undefined) {
    return err(
      appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.id} has no main participant`, {
        channelId: channel.id,
      }),
    );
  }
  const roster = [...participants].sort((left, right) => compareHandles(left.handle, right.handle));
  return ok({
    id: channel.id,
    name: channel.name,
    title: channel.title,
    state: channel.state,
    main: main.handle,
    participantCount: roster.length,
    messageCount: counters.total,
    unhandledCount: counters.unhandled,
    participants: roster.map(participantViewOf),
    createdAt: channel.createdAt,
    closedAt: channel.closedAt,
  });
}

/** Pins the body fields per storage state (section 38.4 line 1716): all named fields present, explicit null. */
export function messageViewOf(record: MessageRecord, resolved: ResolvedMessageBody): MessageView {
  return {
    seq: record.seq,
    kind: record.kind,
    from: record.senderHandle,
    to: record.toHandle,
    ref: record.ref,
    body: resolved.state === "pending" ? null : resolved.text,
    bodyPath: resolved.state === "materialized" ? resolved.path : null,
    bodyPending: resolved.state === "pending",
    handled: record.handled,
    handledAt: record.handledAt,
    handleNote: record.handleNote,
    createdAt: record.createdAt,
  };
}
