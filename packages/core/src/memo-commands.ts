import { createHash } from "node:crypto";
import { decodeCursor, encodeCursor, filterHash } from "./cursor";
import { appError, err, ok, type Result } from "./errors";
import type { Clock, IdGenerator } from "./ids";
import { changeMemo, createMemo, isMemoTimestamp, isMemoUuid, type Memo, type MemoTransition } from "./memos";
import {
  parseMemoCreate,
  parseMemoExecution,
  parseMemoListFilter,
  parseMemoStateRequest,
  parseMemoUpdate,
  type MemoExecution,
  type MemoPage,
  type MemoReceipt,
  type MemoStateRequest,
  type MemoUpdateRequest,
} from "./memo-protocol";
import type { MemoReader, MemoRepository, MemoTransaction } from "./memo-repository";
import { resolveWorkspaceActor, type ProjectCommandPorts } from "./project-commands";

export interface MemoCommandPorts {
  installationId: string;
  memos: MemoRepository;
  clock: Clock;
  ids: IdGenerator;
  defaultPageSize: number;
}

/** Explicit selectors do not need a binding. Only CLI inference uses native workspace resolution. */
export function resolveMemoProject(
  ports: ProjectCommandPorts,
  selector: string | undefined,
  currentDirectory?: { path: string; userHome: string },
): Result<string> {
  if (selector !== undefined) {
    // CLI --project is a slug, including valid slugs that happen to look like UUIDs.
    const project = ports.projects.findProjectBySlug(selector);
    if (!project.ok) return project;
    if (project.value) return ok(project.value.id);
    if (isMemoUuid(selector)) {
      const projects = ports.projects.listProjects();
      if (!projects.ok) return projects;
      return projects.value.some((project) => project.id === selector)
        ? ok(selector)
        : err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
    }
    return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
  }
  if (currentDirectory) {
    const resolved = resolveWorkspaceActor(ports, currentDirectory);
    if (!resolved.ok) return resolved;
    if (resolved.value.kind === "registered_project") return ok(resolved.value.project.id);
  }
  return err(appError("PROJECT_NOT_FOUND", "Select or register a Project for Memos"));
}

const unavailable = () =>
  err(appError("MEMO_REPLAY_UNAVAILABLE", "No retained Memo receipt; the original outcome is unknown"));
const notFound = () => err(appError("MEMO_NOT_FOUND", "Memo does not exist in the selected Project"));
const invalid = () => err(appError("MEMO_INVALID_INPUT", "Invalid Memo identity or execution context"));

function context(ports: MemoCommandPorts): Result<void> {
  return isMemoUuid(ports.installationId) ? ok(undefined) : invalid();
}

function replay(reader: MemoReader, key: string, scope: string, hash: string, now: string): Result<MemoReceipt | null> {
  const stored = reader.receipt(key, scope, now);
  if (!stored.ok) return stored;
  if (!stored.value) return ok(null);
  if (stored.value.requestHash !== hash)
    return err(appError("IDEMPOTENCY_CONFLICT", "Memo key belongs to another request"));
  return ok({ ...stored.value.receipt, replayed: true });
}

/** One semantic identity and one durable authority for every public transport. */
function execute(
  ports: MemoCommandPorts,
  operation: string,
  request: Record<string, unknown>,
  execution: MemoExecution,
  work: (tx: MemoTransaction, now: string) => Result<MemoTransition>,
): Result<MemoReceipt> {
  const checked = context(ports);
  if (!checked.ok) return checked;
  const policy = parseMemoExecution([execution.mode], execution.idempotencyKey, true);
  if (!policy.ok) return policy;
  const scope = `memo:${ports.installationId}:user`;
  const hash = createHash("sha256")
    .update(JSON.stringify([operation, ports.installationId, { kind: "user", id: null }, request]))
    .digest("hex");
  const key = policy.value.idempotencyKey;
  if (policy.value.mode === "replay-only") {
    // Clock sampling occurs after entering the consistent, fenced read transaction.
    return ports.memos.inspect((reader) => {
      const stored = replay(reader, key as string, scope, hash, ports.clock.now().toISOString());
      return !stored.ok ? stored : stored.value ? ok(stored.value) : unavailable();
    });
  }
  return ports.memos.run((tx) => {
    const now = ports.clock.now().toISOString();
    if (key) {
      const stored = replay(tx, key, scope, hash, now);
      if (!stored.ok) return stored;
      if (stored.value) return ok(stored.value);
    }
    const result = work(tx, now);
    if (!result.ok) return result;
    const transition = result.value;
    if (transition.event) {
      const event = tx.appendEvent(ports.ids.next(), transition.event);
      if (!event.ok) return event;
    }
    const receipt = { memo: transition.memo, changed: transition.changed, replayed: false };
    if (key) {
      const saved = tx.storeReceipt(
        key,
        scope,
        hash,
        receipt,
        now,
        new Date(Date.parse(now) + 86_400_000).toISOString(),
      );
      if (!saved.ok) return saved;
    }
    return ok(receipt);
  });
}

export function addMemo(
  ports: MemoCommandPorts,
  input: unknown,
  execution: MemoExecution = { mode: "execute" },
): Result<MemoReceipt> {
  const request = parseMemoCreate(input);
  if (!request.ok) return request;
  const { projectId, title, body } = request.value;
  return execute(ports, "add", { projectId, title, body }, execution, (tx, now) => {
    const project = tx.projectStatus(projectId);
    if (!project.ok) return project;
    if (!project.value) return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
    if (project.value === "archived")
      return err(appError("PROJECT_ARCHIVED", "Cannot add a Memo to an archived Project"));
    const created = createMemo(ports.ids.next(), projectId, { title, body }, now);
    if (!created.ok) return created;
    const inserted = tx.insert(created.value.memo);
    return inserted.ok ? created : inserted;
  });
}

export type MemoMutation = "update" | "done" | "dismiss" | "reopen";
export function mutateMemo(
  ports: MemoCommandPorts,
  operation: MemoMutation,
  id: string,
  input: unknown,
  execution: MemoExecution = { mode: "execute" },
): Result<MemoReceipt> {
  if (!isMemoUuid(id) || !["update", "done", "dismiss", "reopen"].includes(operation)) return invalid();
  const parsed = operation === "update" ? parseMemoUpdate(input) : parseMemoStateRequest(input);
  if (!parsed.ok) return parsed;
  const fields = parsed.value as MemoUpdateRequest;
  const request = {
    id,
    ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
    expectedRowVersion: fields.expectedRowVersion,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.body === undefined ? {} : { body: fields.body }),
  };
  return execute(ports, operation, request, execution, (tx, now) => {
    const current = tx.get(id);
    if (!current.ok) return current;
    if (!current.value || (fields.projectId !== undefined && fields.projectId !== current.value.projectId))
      return notFound();
    const changed = changeMemo(current.value, { operation, ...fields }, now);
    if (!changed.ok) return changed;
    if (!changed.value.changed) return changed;
    if (operation === "reopen") {
      const project = tx.projectStatus(current.value.projectId);
      if (!project.ok) return project;
      if (project.value === "archived")
        return err(appError("PROJECT_ARCHIVED", "Cannot reopen a Memo in an archived Project"));
    }
    const written = tx.compareAndSet(changed.value.memo, fields.expectedRowVersion);
    return written.ok ? changed : written;
  });
}

export const updateMemo = (ports: MemoCommandPorts, id: string, input: unknown, execution?: MemoExecution) =>
  mutateMemo(ports, "update", id, input, execution);
export const doneMemo = (ports: MemoCommandPorts, id: string, input: MemoStateRequest, execution?: MemoExecution) =>
  mutateMemo(ports, "done", id, input, execution);
export const dismissMemo = (ports: MemoCommandPorts, id: string, input: MemoStateRequest, execution?: MemoExecution) =>
  mutateMemo(ports, "dismiss", id, input, execution);
export const reopenMemo = (ports: MemoCommandPorts, id: string, input: MemoStateRequest, execution?: MemoExecution) =>
  mutateMemo(ports, "reopen", id, input, execution);

export function showMemo(ports: MemoCommandPorts, id: string, projectId?: string): Result<Memo> {
  const checked = context(ports);
  if (!checked.ok) return checked;
  if (!isMemoUuid(id) || (projectId !== undefined && !isMemoUuid(projectId))) return invalid();
  const found = ports.memos.get(id);
  if (!found.ok) return found;
  return found.value && (projectId === undefined || projectId === found.value.projectId) ? ok(found.value) : notFound();
}

export function listMemos(ports: MemoCommandPorts, input: unknown): Result<MemoPage> {
  const checked = context(ports);
  if (!checked.ok) return checked;
  const parsed = parseMemoListFilter(input, ports.defaultPageSize);
  if (!parsed.ok) return parsed;
  const filter = parsed.value;
  const identity = filterHash({
    namespace: "memos",
    installationId: ports.installationId,
    project: "projectId" in filter.scope ? filter.scope.projectId : "all",
    state: filter.state,
    query: filter.query,
    limit: filter.limit,
  });
  let after: { createdAt: string; id: string } | undefined;
  if (filter.cursor) {
    const decoded = decodeCursor(filter.cursor, identity);
    if (!decoded.ok) return decoded;
    try {
      const tuple: unknown = JSON.parse(decoded.value.lastSortKey);
      if (
        decoded.value.limit !== filter.limit ||
        !Array.isArray(tuple) ||
        tuple.length !== 2 ||
        !isMemoTimestamp(tuple[0]) ||
        !isMemoUuid(tuple[1])
      )
        throw new Error();
      after = { createdAt: tuple[0], id: tuple[1] };
    } catch {
      return err(appError("CURSOR_INVALID", "Invalid Memo cursor tuple"));
    }
  }
  return ports.memos.inspect((reader) => {
    if ("projectId" in filter.scope) {
      const project = reader.projectStatus(filter.scope.projectId);
      if (!project.ok) return project;
      if (!project.value) return err(appError("PROJECT_NOT_FOUND", "Memo Project does not exist"));
    }
    const rows = ports.memos.list(filter, after);
    if (!rows.ok) return rows;
    const items = rows.value.slice(0, filter.limit);
    const last = items.at(-1);
    return ok({
      items,
      nextCursor:
        rows.value.length > filter.limit && last
          ? encodeCursor({
              filterHash: identity,
              limit: filter.limit,
              lastSortKey: JSON.stringify([last.createdAt, last.id]),
            })
          : null,
    });
  });
}
