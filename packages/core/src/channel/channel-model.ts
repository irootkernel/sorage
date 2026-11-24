import type { AcceptedMemoBody } from "../memo/memo-commands";

/**
 * The Channel domain rebuilt under ADR-0034 (CHN-001 to CHN-014, interface
 * sections 38.3 to 38.6, security section 10.1): Channels addressed by
 * globally unique name with their UUID also accepted, participants by handle,
 * messages by per-Channel sequence number; idempotent create, add, remove,
 * ack and close; post retries safe by content with the duplicate check inside
 * the posting transaction and before the closed and removed checks; posting
 * upstream only; complete-content listing with the body pinned per storage
 * state; and every mutation recording the User actor with the acting
 * participant handle in closed event metadata. There are no participant
 * UUIDs, idempotency keys, row versions, role assertions, assignments,
 * receipts, replay-only modes, `PRAGMA data_version` coherence loops,
 * rollback-and-retry cycles, or result indicators: the posting transaction is
 * the retry boundary, and one clock read per transaction stamps every row and
 * event of that transaction with the same instant.
 */

/** The closed text bounds of interface sections 38.3 and CHN-002. */
export const CHANNEL_NAME_SCALARS = 64;
export const CHANNEL_NAME_BYTES = 256;
export const CHANNEL_TITLE_SCALARS = 200;
export const CHANNEL_TITLE_BYTES = 800;
export const CHANNEL_HANDLE_SCALARS = 64;
export const CHANNEL_HANDLE_BYTES = 256;
export const CHANNEL_REF_SCALARS = 200;
export const CHANNEL_REF_BYTES = 800;
export const CHANNEL_NOTE_BYTES = 8_000;

/** The validated list upper bound of the `channel messages --limit` option (section 38.4). */
export const CHANNEL_LIST_MAX_LIMIT = 200;

/** The Channel domain schema floor: Channel surfaces exist only from version 11 on (SHR-009). */
export const CHANNEL_SCHEMA_FLOOR = 11;

export type ChannelRole = "main" | "worker" | "judge";
export type MessageKind = "report" | "question" | "relay_request";
export type ChannelLifecycleState = "open" | "closed";

/** True for a canonical UUID-shaped string, the form a Channel name may never take (CHN-002). */
export function isChannelUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) &&
    value.toLowerCase() === value
  );
}

// ---------------------------------------------------------------------------
// Records and public DTOs (interface sections 38.3 and 38.4, closed shapes)

/** One persisted Channel row (the `channels` table of schema 11 `channels-v2`). */
export interface ChannelRecord {
  id: string;
  name: string;
  title: string | null;
  state: ChannelLifecycleState;
  createdAt: string;
  closedAt: string | null;
}

/** One persisted participant row: removal sets `removedAt` and never deletes the row, so history keeps attributing old messages. */
export interface ParticipantRecord {
  channelId: string;
  handle: string;
  role: ChannelRole;
  addedAt: string;
  removedAt: string | null;
}

/** One persisted message row's immutable shared-content reference. */
export interface MessageBodyRef {
  recordId: string;
  representation: "inline" | "file";
  materialized: boolean;
  inlineText: string | null;
  storageKey: string | null;
  sizeBytes: number;
  sha256: string;
}

/** One persisted message row (the `channel_messages` table; `seq` is unique within its Channel). */
export interface MessageRecord {
  channelId: string;
  seq: number;
  senderHandle: string;
  kind: MessageKind;
  toHandle: string | null;
  ref: string | null;
  content: MessageBodyRef;
  handled: boolean;
  handledAt: string | null;
  handleNote: string | null;
  createdAt: string;
}

/** The closed public DTOs of interface section 38.4; every named field is present with its null meaning. */
export interface ChannelView {
  id: string;
  name: string;
  title: string | null;
  state: ChannelLifecycleState;
  main: string;
  participantCount: number;
  messageCount: number;
  unhandledCount: number;
  participants: ParticipantView[];
  createdAt: string;
  closedAt: string | null;
}

export interface ChannelSummary {
  id: string;
  name: string;
  title: string | null;
  state: ChannelLifecycleState;
  main: string;
  createdAt: string;
  closedAt: string | null;
}

export interface ParticipantView {
  handle: string;
  role: ChannelRole;
  addedAt: string;
  removedAt: string | null;
}

export interface MessageView {
  seq: number;
  kind: MessageKind;
  from: string;
  to: string | null;
  ref: string | null;
  body: string | null;
  bodyPath: string | null;
  bodyPending: boolean;
  handled: boolean;
  handledAt: string | null;
  handleNote: string | null;
  createdAt: string;
}

/** The accepted body this domain shares with the Memo capture primitive (SHR-012). */
export type AcceptedChannelBody = AcceptedMemoBody;
