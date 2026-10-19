import { createHash } from "node:crypto";
import { isValidStorageKeySegment } from "./artifacts";
import { type AppError, appError, err, ok, type Result } from "./errors";
import {
  type NewHandoffRecord,
  type SendInput,
  type SendOutcome,
  type SendPorts,
  sendRequestHash,
} from "./handoff-commands";
import type { Clock } from "./ids";
import { checkExternalSource } from "./import-policy";
import { type ProjectResolutionPorts, validateProjectSlug } from "./project-commands";
import { resolveSenderIdentity, workspaceKey } from "./workspace-identity";

/** Original CLI send material; recovery never accepts an HTTP body spool. */
export type SendRecoveryInput = Omit<SendInput, "bodyFile" | "originalName" | "idempotencyKey"> & {
  idempotencyKey: string;
};

/** Immutable Handoff facts survive revision, archive and content deletion. */
export type SendRecoveryHandoff = Pick<
  NewHandoffRecord,
  | "id"
  | "dispatchGroupId"
  | "supersedesHandoffId"
  | "title"
  | "senderKind"
  | "senderProjectId"
  | "senderWorkspaceKey"
  | "senderPathSnapshot"
  | "recipientProjectId"
>;

export interface SendRecoveryReceipt {
  requestHash: string;
  responseJson: string;
  expiresAt: string;
}

/** These reads share one validated, consistent Installation snapshot. No cleanup methods. */
export interface SendRecoveryReadPort {
  projectPorts: ProjectResolutionPorts;
  /** Read the existing `send` namespace, including expired rows, without deleting them. */
  findSendReceipt(key: string): Result<SendRecoveryReceipt | null, AppError>;
  findHandoff(id: string): Result<SendRecoveryHandoff | null, AppError>;
}

export interface SendRecoveryPorts extends Pick<SendPorts, "inspectSource" | "digestSource"> {
  clock: Clock;
  /** Invoke once with the coherent private reader; do not retry consumer failures. */
  inspect<T>(read: (snapshot: SendRecoveryReadPort) => Result<T, AppError>): Result<T, AppError>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integrity = (message: string): Result<never, AppError> => err(appError("STORAGE_INTEGRITY_ERROR", message));

/** Decode historical creation data, never current Artifact availability or Handoff state. */
export function parseSendRecoveryOutcome(responseJson: string): Result<SendOutcome, AppError> {
  let value: unknown;
  try {
    value = JSON.parse(responseJson);
  } catch {
    return integrity("the retained send outcome is not valid JSON");
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.handoffs) ||
    value.handoffs.length === 0 ||
    value.replayed !== false ||
    (value.dispatchGroupId !== null && !isUuid(value.dispatchGroupId)) ||
    value.handoffs.length > 1 !== (value.dispatchGroupId !== null)
  ) {
    return integrity("the retained send outcome has an invalid creation shape");
  }
  const handoffs: SendOutcome["handoffs"] = [];
  const ids = new Set<string>();
  const artifacts = new Set<string>();
  const recipients = new Set<string>();
  for (const entry of value.handoffs) {
    if (
      !isRecord(entry) ||
      !isUuid(entry.handoffId) ||
      !isUuid(entry.artifactId) ||
      typeof entry.recipientSlug !== "string" ||
      !validateProjectSlug(entry.recipientSlug).ok ||
      entry.revision !== 1 ||
      entry.rowVersion !== 1 ||
      entry.reviewState !== "awaiting_recipient" ||
      // Always present and null exactly for an inline body (SHR-013): a
      // retained string key keeps its exact managed-path validation, and a
      // null key keeps every identity and duplicate check while owing no path.
      (typeof entry.storageKey !== "string" && entry.storageKey !== null)
    ) {
      return integrity("the retained send outcome has an invalid Handoff entry");
    }
    if (ids.has(entry.handoffId) || artifacts.has(entry.artifactId) || recipients.has(entry.recipientSlug)) {
      return integrity("the retained send outcome has inconsistent paths or duplicate identities");
    }
    if (typeof entry.storageKey === "string") {
      const segments = entry.storageKey.split("/");
      if (
        segments.length !== 4 ||
        segments[0] !== "artifacts" ||
        segments[1] !== entry.handoffId ||
        segments[2] !== entry.artifactId ||
        !isValidStorageKeySegment(segments[3] as string)
      ) {
        return integrity("the retained send outcome has inconsistent paths or duplicate identities");
      }
    }
    ids.add(entry.handoffId);
    artifacts.add(entry.artifactId);
    recipients.add(entry.recipientSlug);
    handoffs.push({
      handoffId: entry.handoffId,
      artifactId: entry.artifactId,
      recipientSlug: entry.recipientSlug,
      storageKey: entry.storageKey,
      revision: 1,
      rowVersion: 1,
      reviewState: "awaiting_recipient",
    });
  }
  return ok({ handoffs, dispatchGroupId: value.dispatchGroupId, replayed: false });
}

function validSender(row: SendRecoveryHandoff, installationId: string): boolean {
  if (row.senderKind === "registered_project") {
    return isUuid(row.senderProjectId) && row.senderWorkspaceKey === null && row.senderPathSnapshot === null;
  }
  if (row.senderKind === "user") {
    return row.senderProjectId === null && row.senderWorkspaceKey === null && row.senderPathSnapshot === null;
  }
  return (
    row.senderKind === "unregistered_workspace" &&
    row.senderProjectId === null &&
    typeof row.senderPathSnapshot === "string" &&
    row.senderPathSnapshot.startsWith("/") &&
    row.senderWorkspaceKey === workspaceKey(installationId, row.senderPathSnapshot)
  );
}

function sameSender(left: SendRecoveryHandoff, right: SendRecoveryHandoff): boolean {
  return (
    left.senderKind === right.senderKind &&
    left.senderProjectId === right.senderProjectId &&
    left.senderWorkspaceKey === right.senderWorkspaceKey &&
    left.senderPathSnapshot === right.senderPathSnapshot
  );
}

/** SND-001..005: inspection only. No operational send, import, receipt cleanup or activation port exists. */
export function recoverSend(ports: SendRecoveryPorts, input: SendRecoveryInput): Result<SendOutcome, AppError> {
  const title = input.title.trim();
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
    return err(appError("CONFIG_INVALID", "send recovery requires the original nonempty idempotency key"));
  }
  if (title === "" || input.to.length === 0 || (input.file !== undefined) === (input.body !== undefined)) {
    return err(appError("CONFIG_INVALID", "send recovery requires recipients, a title and exactly one file or body"));
  }
  if (input.body !== undefined && input.body.trim() === "") {
    return err(appError("CONFIG_INVALID", "the --body text must not be empty"));
  }
  let contentSha256: string;
  let resolvedSourcePath: string | null = null;
  if (input.file !== undefined) {
    const source = ports.inspectSource(input.file, input.userHome);
    if (!source.ok) return source;
    resolvedSourcePath = source.value.resolvedSourcePath;
    const digest = ports.digestSource(resolvedSourcePath);
    if (!digest.ok) return digest;
    contentSha256 = digest.value;
  } else {
    contentSha256 = createHash("sha256")
      .update(input.body as string, "utf8")
      .digest("hex");
  }
  return ports.inspect((snapshot) => {
    // The Clock belongs inside the read callback, after capture has established the snapshot.
    const now = ports.clock.now().getTime();
    const seen = snapshot.findSendReceipt(input.idempotencyKey);
    if (!seen.ok) return seen;
    const projectPorts = snapshot.projectPorts;
    const sender = input.asUser
      ? ok({ kind: "user" as const })
      : resolveSenderIdentity(projectPorts, { ...input, installationId: projectPorts.installationId });
    if (!sender.ok && sender.error.code !== "SENDER_IDENTITY_DOWNGRADE") return sender;
    const path = projectPorts.bindings.realPath(input.path, input.userHome);
    if (!path.ok) return path;
    if (resolvedSourcePath !== null) {
      const source = checkExternalSource({
        resolvedSourcePath,
        workspaceRoot: path.value,
        policy: "workspace_or_explicit",
        allowExternalSource: input.allowExternalSource,
      });
      if (!source.ok) return source;
    }
    const receipt = seen.value;
    if (
      receipt !== null &&
      (!HASH.test(receipt.requestHash) ||
        !Number.isFinite(Date.parse(receipt.expiresAt)) ||
        new Date(receipt.expiresAt).toISOString() !== receipt.expiresAt)
    ) {
      return integrity("the retained send receipt has an invalid hash or expiry");
    }
    if (receipt === null || Date.parse(receipt.expiresAt) <= now) {
      if (!sender.ok) return sender;
      return err(appError("HANDOFF_REPLAY_UNAVAILABLE", "no eligible send receipt; the original outcome is unknown"));
    }
    const parsed = parseSendRecoveryOutcome(receipt.responseJson);
    if (!parsed.ok) return parsed;
    const outcome = parsed.value;
    const rows: SendRecoveryHandoff[] = [];
    for (const entry of outcome.handoffs) {
      const found = snapshot.findHandoff(entry.handoffId);
      if (!found.ok) return found;
      const row = found.value;
      const recipient = projectPorts.projects.findProjectBySlug(entry.recipientSlug);
      if (!recipient.ok) return recipient;
      if (
        row === null ||
        row.id !== entry.handoffId ||
        !validSender(row, projectPorts.installationId) ||
        recipient.value === null ||
        recipient.value.slug !== entry.recipientSlug.toLowerCase() ||
        !isUuid(row.recipientProjectId) ||
        (row.supersedesHandoffId !== null && !isUuid(row.supersedesHandoffId)) ||
        row.recipientProjectId !== recipient.value.id ||
        row.dispatchGroupId !== outcome.dispatchGroupId ||
        (rows[0] !== undefined &&
          (!sameSender(rows[0], row) ||
            rows[0].title !== row.title ||
            rows[0].supersedesHandoffId !== row.supersedesHandoffId))
      ) {
        return integrity("the retained send outcome does not match its immutable Handoff relationships");
      }
      rows.push(row);
    }
    const original = rows[0] as SendRecoveryHandoff;
    const key = workspaceKey(projectPorts.installationId, path.value);
    const inheritedWorkspace =
      input.as === undefined &&
      original.senderKind === "unregistered_workspace" &&
      original.senderWorkspaceKey === key &&
      original.senderPathSnapshot === path.value &&
      (!sender.ok || sender.value.kind === "registered_project");
    const senderMatches =
      sender.ok &&
      (sender.value.kind === "user"
        ? original.senderKind === "user"
        : sender.value.kind === "registered_project"
          ? original.senderKind === "registered_project" && original.senderProjectId === sender.value.project.id
          : original.senderKind === "unregistered_workspace" &&
            original.senderWorkspaceKey === sender.value.workspaceKey);
    const business = {
      to: input.to,
      title,
      contentSha256,
      supersedes: input.supersedes,
      kind: input.file === undefined ? ("body" as const) : ("file" as const),
    };
    const originalHash = sendRequestHash({
      ...business,
      sender: `${original.senderKind}:${original.senderProjectId ?? original.senderWorkspaceKey ?? "user"}`,
    });
    const legacyHash = sendRequestHash(business);
    if (
      !(senderMatches || inheritedWorkspace) ||
      (receipt.requestHash !== originalHash && receipt.requestHash !== legacyHash)
    ) {
      if (!sender.ok && !inheritedWorkspace) return sender;
      return err(
        appError("IDEMPOTENCY_CONFLICT", "the retained receipt does not match the original request and sender"),
      );
    }
    const recipients = new Set(input.to);
    if (
      original.title !== title ||
      original.supersedesHandoffId !== (input.supersedes ?? null) ||
      recipients.size !== outcome.handoffs.length ||
      outcome.handoffs.some((entry) => !recipients.has(entry.recipientSlug))
    ) {
      return integrity("the retained send outcome does not match its business request");
    }
    return ok({ ...outcome, replayed: true });
  });
}
