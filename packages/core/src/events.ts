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

export type ActorKind = "registered_project" | "unregistered_workspace" | "user" | "system";

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

/** The 0.1 slice of the normative event catalog of section 10 of security-reliability.md. */
export const EVENT_TYPES = [
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
  "PROJECT_STATUS_ARCHIVED",
  "PROJECT_STATUS_ACTIVE",
  "PROJECT_RENAMED",
  "CONFIG_CHANGED",
  "VAULT_MOVED",
] as const;

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
