import { ok, type Result } from "../shared/errors";
import { type ChannelDomainEventType, type NewDomainEvent, USER_ACTOR } from "../shared/events";
import { invalid } from "./channel-internal";
import { isChannelUuid, type MessageKind } from "./channel-model";
import { validateChannelHandle } from "./channel-validation";

// ---------------------------------------------------------------------------
// Event metadata (security section 10.1, closed key sets; CHN-013)

/** One Channel event's closed input: the acting handle is the sender for a post and the main handle otherwise. */
export type ChannelEventInput =
  | { type: "CHANNEL_CREATED"; channelId: string; actingHandle: string; mainHandle: string }
  | { type: "CHANNEL_CLOSED"; channelId: string; actingHandle: string }
  | {
      type: "CHANNEL_PARTICIPANT_ADDED";
      channelId: string;
      actingHandle: string;
      handle: string;
      role: "worker" | "judge";
    }
  | { type: "CHANNEL_PARTICIPANT_REMOVED"; channelId: string; actingHandle: string; handle: string }
  | {
      type: "CHANNEL_MESSAGE_POSTED";
      channelId: string;
      actingHandle: string;
      seq: number;
      kind: MessageKind;
      toHandle: string | null;
    }
  | { type: "CHANNEL_MESSAGE_ACKED"; channelId: string; actingHandle: string; seq: number };

/** Builds the ledger row of one Channel event: the User actor, null associations, null row version (section 38.9). */
export function channelDomainEvent(id: string, input: ChannelEventInput, createdAt: string): NewDomainEvent {
  const actor = USER_ACTOR;
  switch (input.type) {
    case "CHANNEL_CREATED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle, mainHandle: input.mainHandle },
        createdAt,
      };
    case "CHANNEL_CLOSED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle },
        createdAt,
      };
    case "CHANNEL_PARTICIPANT_ADDED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: {
          channelId: input.channelId,
          actingHandle: input.actingHandle,
          handle: input.handle,
          role: input.role,
        },
        createdAt,
      };
    case "CHANNEL_PARTICIPANT_REMOVED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle, handle: input.handle },
        createdAt,
      };
    case "CHANNEL_MESSAGE_POSTED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: {
          channelId: input.channelId,
          actingHandle: input.actingHandle,
          seq: input.seq,
          kind: input.kind,
          toHandle: input.toHandle,
        },
        createdAt,
      };
    case "CHANNEL_MESSAGE_ACKED":
      return {
        id,
        handoffId: null,
        eventType: input.type,
        actor,
        rowVersion: null,
        metadata: { channelId: input.channelId, actingHandle: input.actingHandle, seq: input.seq },
        createdAt,
      };
  }
}

function requireClosedKeys(value: Record<string, unknown>, keys: readonly string[]): Result<void> {
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      return invalid(`The ${String(value.eventType ?? "Channel event")} metadata lacks ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return invalid(`The Channel event metadata carries the unknown key ${key}`);
  }
  return ok(undefined);
}

function requireEventHandle(value: unknown, field: string): Result<string> {
  const handle = validateChannelHandle(value);
  if (!handle.ok) return invalid(`Channel event ${field} must be a bounded handle`);
  return handle;
}

function requireEventSeq(value: unknown): Result<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid("Channel event seq must be a positive safe integer");
  }
  return ok(value);
}

/**
 * Validates one Channel event's closed metadata against security section
 * 10.1: the exact key set of its type, a canonical UUID `channelId`, bounded
 * handles, the kind and role enums with their null rules, and a positive safe
 * integer `seq`. No body, title, reference or note text ever appears here
 * (CHN-011).
 */
export function validateChannelEventMetadata(
  eventType: ChannelDomainEventType,
  metadata: Record<string, unknown>,
): Result<void> {
  if (typeof metadata.channelId !== "string" || !isChannelUuid(metadata.channelId)) {
    return invalid("Channel event metadata carries a non-canonical channelId");
  }
  switch (eventType) {
    case "CHANNEL_CREATED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "mainHandle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const main = requireEventHandle(metadata.mainHandle, "mainHandle");
      if (!main.ok) return main;
      if (acting.value !== main.value)
        return invalid("A Channel creation event's acting handle must be its main handle");
      return ok(undefined);
    }
    case "CHANNEL_CLOSED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      return ok(undefined);
    }
    case "CHANNEL_PARTICIPANT_ADDED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "handle", "role"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const handle = requireEventHandle(metadata.handle, "handle");
      if (!handle.ok) return handle;
      if (metadata.role !== "worker" && metadata.role !== "judge") {
        return invalid("A participant addition event carries a non-registration role");
      }
      if (metadata.handle === metadata.actingHandle) return invalid("A participant addition names the main handle");
      return ok(undefined);
    }
    case "CHANNEL_PARTICIPANT_REMOVED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "handle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const handle = requireEventHandle(metadata.handle, "handle");
      if (!handle.ok) return handle;
      if (metadata.handle === metadata.actingHandle) return invalid("A participant removal names the main handle");
      return ok(undefined);
    }
    case "CHANNEL_MESSAGE_POSTED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "seq", "kind", "toHandle"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const seq = requireEventSeq(metadata.seq);
      if (!seq.ok) return seq;
      if (metadata.kind !== "report" && metadata.kind !== "question" && metadata.kind !== "relay_request") {
        return invalid("A message posting event carries an unknown kind");
      }
      if (metadata.kind === "relay_request") {
        if (typeof metadata.toHandle !== "string")
          return invalid("A relay_request posting event must name its target handle");
        const to = requireEventHandle(metadata.toHandle, "toHandle");
        if (!to.ok) return to;
      } else if (metadata.toHandle !== null) {
        return invalid("A non-relay posting event must carry a null toHandle");
      }
      return ok(undefined);
    }
    case "CHANNEL_MESSAGE_ACKED": {
      const closed = requireClosedKeys(metadata, ["channelId", "actingHandle", "seq"]);
      if (!closed.ok) return closed;
      const acting = requireEventHandle(metadata.actingHandle, "actingHandle");
      if (!acting.ok) return acting;
      const seq = requireEventSeq(metadata.seq);
      if (!seq.ok) return seq;
      return ok(undefined);
    }
  }
}
