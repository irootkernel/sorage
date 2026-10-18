import type { AppError } from "./errors";
import { appError, err, ok, type Result } from "./errors";

/**
 * The append-only event ledger of section 10 of security-reliability.md (SEC-012,
 * HND-016, HND-017). Events are appended inside the same database transaction as the
 * mutation that caused them, they never contain Artifact bytes, and the database itself
 * rejects an update or delete against the `events` table. Event type names never share
 * a token with an error code, which is why the Project events say PROJECT_STATUS_ACTIVE
 * while the errors say PROJECT_ARCHIVED.
 */

export const ACTOR_KINDS = ["registered_project", "unregistered_workspace", "user", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export function isActorKind(value: string): value is ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(value);
}

export const MEMO_EVENT_TYPES = [
  "MEMO_CREATED",
  "MEMO_UPDATED",
  "MEMO_MARKED_DONE",
  "MEMO_DISMISSED",
  "MEMO_REOPENED",
] as const;
export type MemoEventType = (typeof MEMO_EVENT_TYPES)[number];

export function isMemoEventType(value: string): value is MemoEventType {
  return (MEMO_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The common physical-content family of M9 (SHR-005, SHR-011, security section 10.1):
 * system-actor events whose closed metadata names the content record, its owner,
 * and the intent that activated or unlinked it. Memo/Channel-owned file content
 * uses this family; Handoff Artifacts keep the existing `ARTIFACT_*` family.
 */
export const COMMON_CONTENT_EVENT_TYPES = [
  "CONTENT_ACTIVATED",
  "CONTENT_UNLINKED",
  "CONTENT_INTEGRITY_FAILED",
] as const;
export type CommonContentEventType = (typeof COMMON_CONTENT_EVENT_TYPES)[number];

export function isCommonContentEventType(value: string): value is CommonContentEventType {
  return (COMMON_CONTENT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The Channel domain family of TASK-109 (CHN-005, interface section 38.9). This
 * build never appends it; snapshot readers know the names only so a recognized
 * later-generation Channel event fails closed as an unsupported representation
 * before import instead of surfacing as unknown-event corruption.
 */
export const CHANNEL_DOMAIN_EVENT_TYPES = [
  "CHANNEL_CREATED",
  "CHANNEL_CLOSED",
  "CHANNEL_PARTICIPANT_REGISTERED",
  "CHANNEL_PARTICIPANT_DEACTIVATED",
  "CHANNEL_ASSIGNMENT_CREATED",
  "CHANNEL_ASSIGNMENT_CLOSED",
  "CHANNEL_MESSAGE_SUBMITTED",
  "CHANNEL_MESSAGE_HANDLED",
] as const;
export type ChannelDomainEventType = (typeof CHANNEL_DOMAIN_EVENT_TYPES)[number];

export function isChannelDomainEventType(value: string): value is ChannelDomainEventType {
  return (CHANNEL_DOMAIN_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The actor recorded on an event: provenance, not authorization. `id` is the Project id
 * for a registered Project, the workspace key for an unregistered Workspace, and null
 * for the User and the system actor (SEC-013, section 2 of domain-and-architecture.md).
 */
export interface ActorRef {
  kind: ActorKind;
  id: string | null;
}

export const USER_ACTOR: ActorRef = { kind: "user", id: null };
export const SYSTEM_ACTOR: ActorRef = { kind: "system", id: null };

export function projectActor(projectId: string): ActorRef {
  return { kind: "registered_project", id: projectId };
}

export function workspaceActor(workspaceKey: string): ActorRef {
  return { kind: "unregistered_workspace", id: workspaceKey };
}

/** The pre-M7 event names, the frozen family a format-1 snapshot may carry. */
export const LEGACY_EVENT_TYPES = [
  "HANDOFF_CREATED",
  "ARTIFACT_FETCHED_FIRST_TIME",
  "REVIEW_NOTE_CREATED",
  "REVIEW_NOTE_UPDATED",
  "REVIEW_NOTE_WITHDRAWN",
  "REVIEW_NOTE_REMOVED",
  "REVIEW_NOTE_RESOLVED",
  "HANDOFF_REVISED",
  "HANDOFF_NO_CHANGE_RESOLVED",
  "HANDOFF_ACCEPTED",
  "HANDOFF_DECLINED",
  "HANDOFF_WITHDRAWN",
  "HANDOFF_PINNED",
  "HANDOFF_UNPINNED",
  "HANDOFF_ARCHIVED",
  "HANDOFF_UNARCHIVED",
  "DELETION_REQUESTED",
  "DELETION_APPROVED",
  "DELETION_REJECTED",
  "ARTIFACT_ACTIVATED",
  "ARTIFACT_UNLINKED",
  "ARTIFACT_INTEGRITY_FAILED",
  "PROJECT_REGISTERED",
  "PROJECT_BINDING_ADDED",
  "PROJECT_BINDING_REMOVED",
  "PROJECT_BINDING_REBOUND",
  "PROJECT_STATUS_ARCHIVED",
  "PROJECT_STATUS_ACTIVE",
  "PROJECT_RENAMED",
  "CONFIG_CHANGED",
  "VAULT_MOVED",
  "VAULT_ADOPTED",
  "RESTORE_COMPLETED",
] as const;

/** The normative event catalog of section 10 of security-reliability.md this build may append. */
export const EVENT_TYPES = [...LEGACY_EVENT_TYPES, ...MEMO_EVENT_TYPES, ...COMMON_CONTENT_EVENT_TYPES] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** A new ledger row before the append; the id and timestamp come from the caller's clock and ids. */
export interface NewDomainEvent {
  id: string;
  handoffId?: string | null;
  eventType: EventType;
  actor: ActorRef;
  rowVersion?: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * The in-transaction append port (HND-016). An adapter implementation runs inside the
 * caller's open write transaction and lets a failure abort that whole transaction; the
 * ledger is never appended outside the mutation it describes.
 */
export interface EventAppendPort {
  append(event: NewDomainEvent): void;
}

/** One persisted ledger row as the read side returns it. */
export interface DomainEventRow {
  id: string;
  handoffId: string | null;
  eventType: string;
  actorKind: string;
  actorId: string | null;
  rowVersion: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** True when the value is a declared event type; unknown types never reach the ledger. */
export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** Builds the typed error for an undecodable or non-catalog event name, for adapter parsing. */
export function unknownEventType(value: string): AppError {
  return appError("INTERNAL_ERROR", `the value '${value}' is not a catalog event type`);
}

/** Validates metadata serializability before an append so the ledger never stores ad-hoc objects. */
export function encodeEventMetadata(metadata: Record<string, unknown>): Result<string, AppError> {
  try {
    return ok(JSON.stringify(metadata));
  } catch {
    return err(appError("INTERNAL_ERROR", "event metadata is not JSON-serializable"));
  }
}

/**
 * The frozen per-format snapshot event families (interface section 38.9): formats 1
 * and 2 keep their pre-M9 allowlists however the runtime union grows, and format 3
 * adds exactly the common physical-content family. Channel domain events belong to
 * no format this build reads and are classified before this family check.
 */
export function snapshotEventTypeAllowed(formatVersion: 1 | 2 | 3, eventType: string): boolean {
  if (formatVersion === 1) return (LEGACY_EVENT_TYPES as readonly string[]).includes(eventType);
  if (formatVersion === 2)
    return (
      (LEGACY_EVENT_TYPES as readonly string[]).includes(eventType) ||
      (MEMO_EVENT_TYPES as readonly string[]).includes(eventType)
    );
  return (
    (LEGACY_EVENT_TYPES as readonly string[]).includes(eventType) ||
    (MEMO_EVENT_TYPES as readonly string[]).includes(eventType) ||
    (COMMON_CONTENT_EVENT_TYPES as readonly string[]).includes(eventType)
  );
}
