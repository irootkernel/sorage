import type { LargeContentDisclosurePorts } from "../primitives/disclosures";
import type { Clock, IdGenerator } from "../primitives/ids";
import type { AppError, Result } from "../shared/errors";
import type { ChannelEventInput } from "./channel-events";
import type {
  AcceptedChannelBody,
  ChannelRecord,
  ChannelRole,
  ChannelSummary,
  MessageBodyRef,
  MessageKind,
  MessageRecord,
  ParticipantRecord,
} from "./channel-model";

// ---------------------------------------------------------------------------
// Ports and the repository contract

/** The file-body staging and activation seam shared with the Memo domain (SHR-005, CHN-014). */
export interface ChannelStagingPorts {
  freshBinding(): Result<{ vaultPath: string }, AppError>;
  /** Streams the accepted body's exact bytes into the bound Vault's `staging/` tree; never a whole-body buffer. */
  stageAccepted(
    accepted: AcceptedChannelBody,
    binding: { vaultPath: string },
  ): Result<{ stagedPath: string; sizeBytes: number; sha256: string }, AppError>;
  /** The post-commit activation gate and shared completion transaction; `paused` leaves the committed intent durably pending. */
  activateContent(
    input: {
      intentId: string;
      contentId: string;
      ownerChannelId: string;
      stagedPath: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    },
    binding: { vaultPath: string },
  ): Result<{ status: "completed" } | { status: "paused" }, AppError>;
}

/** The resolved body state of one message, pinned per storage state (interface section 38.4). */
export type ResolvedMessageBody =
  | { state: "inline"; text: string }
  | { state: "materialized"; text: string; path: string }
  | { state: "pending" };

/** The bounded body readers backed by the shared content store; bodies resolve outside every transaction. */
export interface ChannelBodyPorts {
  /** The full accepted-body nonblank proof (CHN-004): bounded chunks over the exact spool bytes. */
  proveAcceptedNonBlank(accepted: AcceptedChannelBody): Result<void, AppError>;
  /** Resolves one record's complete body against the current Vault binding; a corrupt file is a typed refusal. */
  resolveBody(ref: MessageBodyRef): Result<ResolvedMessageBody, AppError>;
}

/** One page query of the message listing: unhandled by default, `--after` on the sequence key (section 38.4). */
export interface MessagePageQuery {
  handling: "unhandled" | "all";
  afterSeq: number | null;
  fromHandle: string | null;
  kind: MessageKind | null;
}

export interface ChannelCounters {
  total: number;
  unhandled: number;
}

/** The mutation transaction: one `BEGIN IMMEDIATE` through the shared helper, one clock read per transaction. */
export interface ChannelTransaction {
  channelByName(name: string): Result<ChannelRecord | null, AppError>;
  channelById(id: string): Result<ChannelRecord | null, AppError>;
  participants(channelId: string): Result<ParticipantRecord[], AppError>;
  participant(channelId: string, handle: string): Result<ParticipantRecord | null, AppError>;
  messageBySeq(channelId: string, seq: number): Result<MessageRecord | null, AppError>;
  pageMessages(channelId: string, query: MessagePageQuery, limit: number): Result<MessageRecord[], AppError>;
  counters(channelId: string): Result<ChannelCounters, AppError>;
  /** The NULL-safe duplicate lookup of CHN-005: same Channel, sender, kind, `--to`, `--ref` and body digest, unhandled only. */
  findUnhandledDuplicate(
    channelId: string,
    senderHandle: string,
    kind: MessageKind,
    toHandle: string | null,
    ref: string | null,
    bodySha256: string,
  ): Result<MessageRecord | null, AppError>;
  nextSeq(channelId: string): Result<number, AppError>;
  /** Records the plan's immutable content record — and, for a file plan, its activation intent — inside this open transaction. */
  commitContent(plan: ChannelContentPlan, ownerChannelId: string, createdAt: string): Result<void, AppError>;
  insertMessage(row: MessageRecord): Result<void, AppError>;
  insertChannel(row: ChannelRecord): Result<void, AppError>;
  insertParticipant(channelId: string, handle: string, role: ChannelRole, addedAt: string): Result<void, AppError>;
  reRegisterParticipant(channelId: string, handle: string, addedAt: string): Result<void, AppError>;
  removeParticipant(channelId: string, handle: string, removedAt: string): Result<void, AppError>;
  closeChannelRow(id: string, closedAt: string): Result<"changed" | "unchanged", AppError>;
  markHandled(channelId: string, seq: number, handledAt: string, note: string | null): Result<void, AppError>;
  appendEvent(id: string, event: ChannelEventInput, createdAt: string): Result<void, AppError>;
}

/** The read side: one plain `BEGIN`/`COMMIT` with no SQL fence check; the covered-read admission checked the fence once. */
export interface ChannelReader {
  channelByName(name: string): Result<ChannelRecord | null, AppError>;
  channelById(id: string): Result<ChannelRecord | null, AppError>;
  participants(channelId: string): Result<ParticipantRecord[], AppError>;
  participant(channelId: string, handle: string): Result<ParticipantRecord | null, AppError>;
  pageMessages(channelId: string, query: MessagePageQuery, limit: number): Result<MessageRecord[], AppError>;
  counters(channelId: string): Result<ChannelCounters, AppError>;
  listChannels(filter: { state: "open" | "closed" | "all" }): Result<ChannelSummary[], AppError>;
}

export interface ChannelRepository {
  run<T>(work: (transaction: ChannelTransaction) => Result<T, AppError>): Result<T, AppError>;
  read<T>(work: (reader: ChannelReader) => Result<T, AppError>): Result<T, AppError>;
}

/** The content plan a post commits atomically with its rows (SHR-004, SHR-005). */
export type ChannelContentPlan =
  | { kind: "inline"; contentId: string; text: string; sizeBytes: number; sha256: string }
  | {
      kind: "file";
      contentId: string;
      intentId: string;
      stagedPath: string;
      storageKey: string;
      sizeBytes: number;
      sha256: string;
    };

export interface ChannelCommandPorts {
  installationId: string;
  maxBytes: number;
  defaultPageSize: number;
  channels: ChannelRepository;
  bodies: ChannelBodyPorts;
  staging: ChannelStagingPorts;
  clock: Clock;
  ids: IdGenerator;
  /** The SHR-011 large-content disclosure seam and the contained post-commit warning sink: firing never changes the outcome. */
  disclosures?: LargeContentDisclosurePorts;
}
