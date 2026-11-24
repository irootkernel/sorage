import { buildContentStorageKey } from "../content/content";
import { discloseLargeContent as emitLargeContentDisclosure, emitCompletionWarning } from "../primitives/disclosures";
import { appError, err, ok, type Result } from "../shared/errors";
import { channelNotFound, invalid, resolveChannel } from "./channel-internal";
import type { AcceptedChannelBody, MessageKind, MessageRecord, MessageView } from "./channel-model";
import type { ChannelCommandPorts, ChannelContentPlan } from "./channel-ports";
import {
  channelBodyRoutesFile,
  checkChannelBodyText,
  validateChannelHandle,
  validateHandleNote,
  validateMessageRef,
} from "./channel-validation";
import { messageViewOf } from "./channel-views";

export interface PostMessageInput {
  channelRef: unknown;
  from: unknown;
  kind: unknown;
  to?: unknown;
  ref?: unknown;
  accepted: AcceptedChannelBody;
}

/** The one SQL transaction's fresh outcome, before its post-commit activation half. */
interface FreshPostOutcome {
  message: MessageRecord;
  plan: ChannelContentPlan;
  channelId: string;
  binding: { vaultPath: string } | null;
}

type PostOutcome = { duplicate: true; message: MessageRecord } | ({ duplicate: false } & FreshPostOutcome);

/**
 * Posts one attributed message (CHN-004, CHN-005, section 38.6). The body is
 * captured once per invocation outside every transaction; a file-routed body
 * stages into the bound Vault's `staging/` tree before the transaction. The
 * one `BEGIN IMMEDIATE` transaction runs, in order: the Channel resolution,
 * the NULL-safe duplicate check — same Channel, sender, kind, `--to`, `--ref`
 * and body digest over the unhandled window — which returns the original with
 * `duplicate: true` before the closed and removed checks so a retry after
 * close still reports the duplicate, the closed refusal, the sender and relay
 * target checks, the staged file's Vault-binding re-read (CHN-014), the
 * content record and message insert with its sequence number, the
 * `CHANNEL_MESSAGE_POSTED` event whose acting handle is the sender, and the
 * in-transaction result-row read. After the commit a file body activates
 * behind the move-lock gate; a paused or failed activation leaves the
 * committed message with `bodyPending: true` and the failure disclosed as a
 * warning (CHN-012).
 */
export function postMessage(
  ports: ChannelCommandPorts,
  input: PostMessageInput,
): Result<{ message: MessageView; duplicate: boolean }> {
  if (typeof input.channelRef !== "string") return invalid("A post requires a Channel name or UUID");
  const from = validateChannelHandle(input.from);
  if (!from.ok) return from;
  if (input.kind !== "report" && input.kind !== "question" && input.kind !== "relay_request") {
    return invalid("A post requires --kind report, question or relay_request");
  }
  const kind: MessageKind = input.kind;
  if (kind === "relay_request") {
    if (input.to === undefined || input.to === null) {
      return invalid("A relay_request post requires --to naming an active registered participant");
    }
  } else if (input.to !== undefined && input.to !== null) {
    return invalid("The --to target belongs to relay_request posts only");
  }
  const toHandle = input.to === undefined || input.to === null ? null : validateChannelHandle(input.to);
  if (toHandle !== null && !toHandle.ok) return toHandle;
  const reference = validateMessageRef(input.ref);
  if (!reference.ok) return reference;

  // The prepared material, computed once before any transaction (the P3 discipline).
  if (input.accepted.kind === "text") {
    const text = checkChannelBodyText(input.accepted.text, ports.maxBytes);
    if (!text.ok) return text;
  } else {
    const nonBlank = ports.bodies.proveAcceptedNonBlank(input.accepted);
    if (!nonBlank.ok) return nonBlank;
  }
  const routesFile = channelBodyRoutesFile(input.accepted);
  let staged: { binding: { vaultPath: string }; stagedPath: string } | null = null;
  if (routesFile) {
    const binding = ports.staging.freshBinding();
    if (!binding.ok) return binding;
    const stage = ports.staging.stageAccepted(input.accepted, binding.value);
    if (!stage.ok) return stage;
    if (stage.value.sizeBytes !== input.accepted.sizeBytes || stage.value.sha256 !== input.accepted.sha256) {
      return err(appError("STORAGE_INTEGRITY_ERROR", "The accepted Channel body changed before staging completed"));
    }
    staged = { binding: binding.value, stagedPath: stage.value.stagedPath };
  }

  const outcome = ports.channels.run((tx): Result<PostOutcome> => {
    const now = ports.clock.now().toISOString();
    const channel = resolveChannel(tx, input.channelRef as string);
    if (!channel.ok) return channel;
    if (channel.value === null) return channelNotFound(input.channelRef as string);

    // The duplicate check first (CHN-005, section 38.6): before the closed and
    // removed checks, over the unhandled window only.
    const duplicate = tx.findUnhandledDuplicate(
      channel.value.id,
      from.value,
      kind,
      toHandle === null ? null : toHandle.value,
      reference.value,
      input.accepted.sha256,
    );
    if (!duplicate.ok) return duplicate;
    if (duplicate.value !== null) {
      return ok({ duplicate: true, message: duplicate.value });
    }

    if (channel.value.state === "closed") {
      return err(
        appError("CHN_CLOSED", `The Channel ${channel.value.name} is closed; posting is frozen`, {
          channelId: channel.value.id,
        }),
      );
    }
    const sender = tx.participant(channel.value.id, from.value);
    if (!sender.ok) return sender;
    if (sender.value === null || sender.value.removedAt !== null) {
      return err(
        appError(
          "CHN_PARTICIPANT_NOT_FOUND",
          `Unknown or removed sender handle on the Channel ${channel.value.name}: ${from.value}`,
          {
            channelId: channel.value.id,
            handle: from.value,
          },
        ),
      );
    }
    if (sender.value.role === "main") {
      return invalid(
        `The main handle never posts: main-to-agent dispatch stays consumer-owned, and workers and judges post upstream only`,
      );
    }
    if (toHandle?.ok) {
      const target = tx.participant(channel.value.id, toHandle.value);
      if (!target.ok) return target;
      if (target.value === null || target.value.removedAt !== null) {
        return err(
          appError(
            "CHN_PARTICIPANT_NOT_FOUND",
            `Unknown or removed --to handle on the Channel ${channel.value.name}: ${toHandle.value}`,
            { channelId: channel.value.id, handle: toHandle.value },
          ),
        );
      }
    }
    if (staged !== null) {
      // The CHN-014 staged-file binding re-read inside the transaction: a move
      // that switched the destination between staging and commit rolls the
      // post back instead of committing a body staged into a foreign Vault.
      const current = ports.staging.freshBinding();
      if (!current.ok) return current;
      if (current.value.vaultPath !== staged.binding.vaultPath) {
        return err({
          ...appError("CONFIG_CONFLICT", "The Vault path changed while this post was being prepared"),
          recovery: { suggestedCommand: "Reload the configuration and retry the identical post" },
        });
      }
    }

    const seq = tx.nextSeq(channel.value.id);
    if (!seq.ok) return seq;
    const contentId = ports.ids.next();
    const storageKey = buildContentStorageKey({ domain: "channel", ownerId: channel.value.id, contentId });
    if (!storageKey.ok) return storageKey;
    const plan: ChannelContentPlan = routesFile
      ? {
          kind: "file",
          contentId,
          intentId: ports.ids.next(),
          stagedPath: (staged as { stagedPath: string }).stagedPath,
          storageKey: storageKey.value,
          sizeBytes: input.accepted.sizeBytes,
          sha256: input.accepted.sha256,
        }
      : {
          kind: "inline",
          contentId,
          text: input.accepted.kind === "text" ? input.accepted.text : "",
          sizeBytes: input.accepted.sizeBytes,
          sha256: input.accepted.sha256,
        };
    const committed = tx.commitContent(plan, channel.value.id, now);
    if (!committed.ok) return committed;
    const inserted = tx.insertMessage({
      channelId: channel.value.id,
      seq: seq.value,
      senderHandle: from.value,
      kind,
      toHandle: toHandle === null ? null : toHandle.value,
      ref: reference.value,
      content: {
        recordId: contentId,
        representation: routesFile ? "file" : "inline",
        materialized: !routesFile,
        inlineText: routesFile ? null : input.accepted.kind === "text" ? input.accepted.text : null,
        storageKey: routesFile ? storageKey.value : null,
        sizeBytes: input.accepted.sizeBytes,
        sha256: input.accepted.sha256,
      },
      handled: false,
      handledAt: null,
      handleNote: null,
      createdAt: now,
    });
    if (!inserted.ok) return inserted;
    const appended = tx.appendEvent(
      ports.ids.next(),
      {
        type: "CHANNEL_MESSAGE_POSTED",
        channelId: channel.value.id,
        actingHandle: from.value,
        seq: seq.value,
        kind,
        toHandle: toHandle === null ? null : toHandle.value,
      },
      now,
    );
    if (!appended.ok) return appended;
    const readBack = tx.messageBySeq(channel.value.id, seq.value);
    if (!readBack.ok) return readBack;
    if (readBack.value === null) {
      return err(
        appError(
          "STORAGE_INTEGRITY_ERROR",
          `The posted message ${String(seq.value)} could not be read back inside its transaction`,
        ),
      );
    }
    return ok({
      duplicate: false,
      message: readBack.value,
      plan,
      channelId: channel.value.id,
      binding: staged === null ? null : staged.binding,
    });
  });
  if (!outcome.ok) return outcome;

  if (outcome.value.duplicate) {
    const resolved = ports.bodies.resolveBody(outcome.value.message.content);
    if (!resolved.ok) {
      // Only a genuinely unactivated body is pending without a word; a
      // corrupt or missing materialized body is disclosed, never described
      // as awaiting activation (SHR-005, CHN-012).
      if (resolved.error.code !== "CONTENT_MATERIALIZING") {
        emitContainedWarning(ports, resolved.error.message);
      }
      return ok({ message: messageViewOf(outcome.value.message, { state: "pending" }), duplicate: true });
    }
    return ok({ message: messageViewOf(outcome.value.message, resolved.value), duplicate: true });
  }

  // The post-commit half: disclosure, activation, and the body resolution of
  // the committed view. A failure here never becomes a plain failure of the
  // committed post (CHN-012, SHR-015).
  discloseLargeContent(ports, outcome.value.plan.sizeBytes);
  let pending = false;
  if (outcome.value.plan.kind === "file" && outcome.value.binding !== null) {
    const activation = ports.staging.activateContent(
      {
        intentId: outcome.value.plan.intentId,
        contentId: outcome.value.plan.contentId,
        ownerChannelId: outcome.value.channelId,
        stagedPath: outcome.value.plan.stagedPath,
        storageKey: outcome.value.plan.storageKey,
        sizeBytes: outcome.value.plan.sizeBytes,
        sha256: outcome.value.plan.sha256,
      },
      outcome.value.binding,
    );
    if (!activation.ok) {
      emitContainedWarning(ports, activation.error.message);
      pending = true;
    } else if (activation.value.status === "paused") {
      emitContainedWarning(
        ports,
        "the Channel message committed but its content activation paused behind a held Vault-move lock; the pending intent remains for the next process start",
      );
      pending = true;
    }
  }
  if (pending) {
    return ok({ message: messageViewOf(outcome.value.message, { state: "pending" }), duplicate: false });
  }
  const resolved = ports.bodies.resolveBody(outcome.value.message.content);
  if (!resolved.ok) {
    emitContainedWarning(ports, resolved.error.message);
    return ok({ message: messageViewOf(outcome.value.message, { state: "pending" }), duplicate: false });
  }
  return ok({ message: messageViewOf(outcome.value.message, resolved.value), duplicate: false });
}

/** The SHR-011 large-content Git-history disclosure, fired once after the fresh body's SQL commit. */
function discloseLargeContent(ports: ChannelCommandPorts, sizeBytes: number): void {
  emitLargeContentDisclosure(ports.disclosures, sizeBytes);
}

/** The contained post-commit warning sink (SHR-015): a throwing sink never changes the result. */
function emitContainedWarning(ports: ChannelCommandPorts, text: string): void {
  emitCompletionWarning(ports.disclosures, text);
}

export interface AckMessagesInput {
  channelRef: unknown;
  seqs: number[];
  note?: unknown;
}

/**
 * Records the User handling decision for the named messages (CHN-006):
 * all-or-nothing — any unknown sequence number refuses with
 * `CHN_MESSAGE_NOT_FOUND` naming them and commits nothing — already-handled
 * messages are reported as `alreadyHandled` without a commit or an event, a
 * repeat ack commits nothing, the first decision is immutable, and the
 * operation is available on a closed Channel.
 */
export function ackMessages(
  ports: ChannelCommandPorts,
  input: AckMessagesInput,
): Result<{ handled: number[]; alreadyHandled: number[]; note: string | null }> {
  if (typeof input.channelRef !== "string") return invalid("An ack requires a Channel name or UUID");
  const note = validateHandleNote(input.note);
  if (!note.ok) return note;
  const requested = [...new Set(input.seqs)].sort((left, right) => left - right);
  if (requested.length === 0) return invalid("An ack requires at least one sequence number");
  for (const seq of requested) {
    if (!Number.isSafeInteger(seq) || seq < 1) return invalid("Sequence numbers are positive integers");
  }
  return ports.channels.run((tx): Result<{ handled: number[]; alreadyHandled: number[]; note: string | null }> => {
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
    const handled: number[] = [];
    const alreadyHandled: number[] = [];
    const missing: number[] = [];
    for (const seq of requested) {
      const message = tx.messageBySeq(channel.value.id, seq);
      if (!message.ok) return message;
      if (message.value === null) {
        missing.push(seq);
        continue;
      }
      if (message.value.handled) alreadyHandled.push(seq);
      else handled.push(seq);
    }
    if (missing.length > 0) {
      return err(
        appError(
          "CHN_MESSAGE_NOT_FOUND",
          `Unknown sequence number${missing.length === 1 ? "" : "s"} on the Channel ${channel.value.name}: ${missing.map((seq) => String(seq)).join(", ")}`,
          { channelId: channel.value.id, missing },
        ),
      );
    }
    for (const seq of handled) {
      const marked = tx.markHandled(channel.value.id, seq, now, note.value);
      if (!marked.ok) return marked;
      const appended = tx.appendEvent(
        ports.ids.next(),
        { type: "CHANNEL_MESSAGE_ACKED", channelId: channel.value.id, actingHandle: acting.handle, seq },
        now,
      );
      if (!appended.ok) return appended;
    }
    return ok({ handled, alreadyHandled, note: note.value });
  });
}
