import { appError, err, ok, type Result } from "../shared/errors";
import { channelNotFound, invalid, resolveChannel } from "./channel-internal";
import type { ChannelRecord, ChannelView, ParticipantView } from "./channel-model";
import type { ChannelCommandPorts } from "./channel-ports";
import { normalizeChannelTitle, validateChannelHandle, validateChannelName } from "./channel-validation";
import { channelViewOf, participantViewOf } from "./channel-views";

// ---------------------------------------------------------------------------
// Commands (interface section 38.4)

export interface CreateChannelInput {
  name: unknown;
  title?: unknown;
  main?: unknown;
}

/**
 * Creates one open Channel with its single main participant, idempotently
 * (CHN-003, CHN-008): the same name and main handle returns the existing open
 * Channel with `existing: true` and appends nothing; a closed name refuses
 * with `CHN_CLOSED`; a different main handle on an existing name refuses with
 * `CHN_INVALID_INPUT`.
 */
export function createChannel(
  ports: ChannelCommandPorts,
  input: CreateChannelInput,
): Result<{ channel: ChannelView; existing: boolean }> {
  if (typeof input.name !== "string") return invalid("Channel create requires a name");
  const name = validateChannelName(input.name);
  if (!name.ok) return name;
  const title = normalizeChannelTitle(input.title);
  if (!title.ok) return title;
  const mainHandle = validateChannelHandle(input.main === undefined ? "main" : input.main);
  if (!mainHandle.ok) return mainHandle;
  return ports.channels.run((tx): Result<{ channel: ChannelView; existing: boolean }> => {
    const now = ports.clock.now().toISOString();
    const existing = tx.channelByName(name.value);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      if (existing.value.state === "closed") {
        return err(
          appError("CHN_CLOSED", `The Channel name ${name.value} belongs to a closed Channel; create uses a new name`, {
            channelId: existing.value.id,
          }),
        );
      }
      const roster = tx.participants(existing.value.id);
      if (!roster.ok) return roster;
      const main = roster.value.find((participant) => participant.role === "main");
      if (main === undefined || main.handle !== mainHandle.value) {
        return invalid(
          `The Channel name ${name.value} already exists with main handle ${main === undefined ? "unknown" : main.handle}`,
        );
      }
      const counters = tx.counters(existing.value.id);
      if (!counters.ok) return counters;
      const view = channelViewOf(existing.value, roster.value, counters.value);
      if (!view.ok) return view;
      return ok({ channel: view.value, existing: true });
    }
    const id = ports.ids.next();
    const record: ChannelRecord = {
      id,
      name: name.value,
      title: title.value,
      state: "open",
      createdAt: now,
      closedAt: null,
    };
    const inserted = tx.insertChannel(record);
    if (!inserted.ok) return inserted;
    const registered = tx.insertParticipant(id, mainHandle.value, "main", now);
    if (!registered.ok) return registered;
    const appended = tx.appendEvent(
      ports.ids.next(),
      { type: "CHANNEL_CREATED", channelId: id, actingHandle: mainHandle.value, mainHandle: mainHandle.value },
      now,
    );
    if (!appended.ok) return appended;
    const roster = tx.participants(id);
    if (!roster.ok) return roster;
    const counters = tx.counters(id);
    if (!counters.ok) return counters;
    const view = channelViewOf(record, roster.value, counters.value);
    if (!view.ok) return view;
    return ok({ channel: view.value, existing: false });
  });
}

export interface AddParticipantInput {
  channelRef: unknown;
  handle: unknown;
  role: unknown;
}

/**
 * Registers one worker or judge participant on an open Channel, idempotently
 * per handle and role (CHN-003): a repeat `add` of the same handle and role
 * returns the participant; a different role for a registered handle refuses
 * with `CHN_INVALID_INPUT`; a removed handle is re-registered — clearing
 * `removedAt` and recording a new `addedAt` under its original role — with a
 * fresh `CHANNEL_PARTICIPANT_ADDED` event; a closed Channel refuses with
 * `CHN_CLOSED`.
 */
export function addParticipant(
  ports: ChannelCommandPorts,
  input: AddParticipantInput,
): Result<{ participant: ParticipantView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel add requires a Channel name or UUID");
  const handle = validateChannelHandle(input.handle);
  if (!handle.ok) return handle;
  if (input.role !== "worker" && input.role !== "judge") {
    return invalid("Channel add requires --role worker or judge");
  }
  const role: "worker" | "judge" = input.role;
  return ports.channels.run((tx): Result<{ participant: ParticipantView }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    if (channel.value.state === "closed") {
      return err(
        appError("CHN_CLOSED", `The Channel ${channel.value.name} is closed; participant registration is frozen`, {
          channelId: channel.value.id,
        }),
      );
    }
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const existing = tx.participant(channel.value.id, handle.value);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      if (existing.value.role !== role) {
        return invalid(
          `The handle ${handle.value} is already registered with role ${existing.value.role}; a re-add keeps its original role`,
        );
      }
      if (existing.value.removedAt !== null) {
        const reRegistered = tx.reRegisterParticipant(channel.value.id, handle.value, now);
        if (!reRegistered.ok) return reRegistered;
        const appended = tx.appendEvent(
          ports.ids.next(),
          {
            type: "CHANNEL_PARTICIPANT_ADDED",
            channelId: channel.value.id,
            actingHandle: acting.handle,
            handle: handle.value,
            role: role,
          },
          now,
        );
        if (!appended.ok) return appended;
        return ok({ participant: { handle: handle.value, role: role, addedAt: now, removedAt: null } });
      }
      return ok({ participant: participantViewOf(existing.value) });
    }
    const inserted = tx.insertParticipant(channel.value.id, handle.value, role, now);
    if (!inserted.ok) return inserted;
    const appended = tx.appendEvent(
      ports.ids.next(),
      {
        type: "CHANNEL_PARTICIPANT_ADDED",
        channelId: channel.value.id,
        actingHandle: acting.handle,
        handle: handle.value,
        role: role,
      },
      now,
    );
    if (!appended.ok) return appended;
    return ok({ participant: { handle: handle.value, role: role, addedAt: now, removedAt: null } });
  });
}

export interface RemoveParticipantInput {
  channelRef: unknown;
  handle: unknown;
}

/**
 * Removes one participant idempotently, in any Channel state (CHN-003): a
 * removed handle cannot post until re-added, the main handle is never
 * removable, and a repeat removal returns the participant without an event.
 */
export function removeParticipant(
  ports: ChannelCommandPorts,
  input: RemoveParticipantInput,
): Result<{ participant: ParticipantView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel remove requires a Channel name or UUID");
  const handle = validateChannelHandle(input.handle);
  if (!handle.ok) return handle;
  return ports.channels.run((tx): Result<{ participant: ParticipantView }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const existing = tx.participant(channel.value.id, handle.value);
    if (!existing.ok) return existing;
    if (existing.value === null) {
      return err(
        appError("CHN_PARTICIPANT_NOT_FOUND", `Unknown handle on the Channel ${channel.value.name}: ${handle.value}`, {
          channelId: channel.value.id,
          handle: handle.value,
        }),
      );
    }
    if (existing.value.role === "main") {
      return invalid(
        "The main participant cannot be removed; exactly one main participant exists for the Channel's life",
      );
    }
    if (existing.value.removedAt !== null) {
      return ok({ participant: participantViewOf(existing.value) });
    }
    const removed = tx.removeParticipant(channel.value.id, handle.value, now);
    if (!removed.ok) return removed;
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const appended = tx.appendEvent(
      ports.ids.next(),
      {
        type: "CHANNEL_PARTICIPANT_REMOVED",
        channelId: channel.value.id,
        actingHandle: acting.handle,
        handle: handle.value,
      },
      now,
    );
    if (!appended.ok) return appended;
    return ok({
      participant: { handle: handle.value, role: existing.value.role, addedAt: existing.value.addedAt, removedAt: now },
    });
  });
}

export interface CloseChannelInput {
  channelRef: unknown;
}

/**
 * Closes one Channel idempotently (CHN-008): a terminal close freezes posting
 * and participant registration while reads and acks remain available; a
 * repeat close returns the Channel without an event.
 */
export function closeChannel(ports: ChannelCommandPorts, input: CloseChannelInput): Result<{ channel: ChannelView }> {
  if (typeof input.channelRef !== "string") return invalid("Channel close requires a Channel name or UUID");
  return ports.channels.run((tx): Result<{ channel: ChannelView }> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);
    const roster = tx.participants(channel.value.id);
    if (!roster.ok) return roster;
    const acting = roster.value.find((participant) => participant.role === "main");
    if (acting === undefined) {
      return err(
        appError("STORAGE_INTEGRITY_ERROR", `The Channel ${channel.value.id} has no main participant`, {
          channelId: channel.value.id,
        }),
      );
    }
    const closed = tx.closeChannelRow(channel.value.id, now);
    if (!closed.ok) return closed;
    let record = channel.value;
    if (closed.value === "changed") {
      const appended = tx.appendEvent(
        ports.ids.next(),
        { type: "CHANNEL_CLOSED", channelId: channel.value.id, actingHandle: acting.handle },
        now,
      );
      if (!appended.ok) return appended;
      record = { ...channel.value, state: "closed", closedAt: now };
    }
    const counters = tx.counters(channel.value.id);
    if (!counters.ok) return counters;
    const view = channelViewOf(record, roster.value, counters.value);
    if (!view.ok) return view;
    return ok({ channel: view.value });
  });
}
