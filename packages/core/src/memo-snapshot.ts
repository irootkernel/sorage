import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonLine,
  snapshotFiles,
  snapshotManifest,
  type SnapshotData,
  type SnapshotFile,
  type SnapshotEvent,
} from "./backup-snapshot";
import { appError, err, ok, type Result } from "./errors";
import { isActorKind, isEventType, isMemoEventType, type MemoEventType } from "./events";
import { memoObject, parseMemoDetail } from "./memo-protocol";
import { type Memo, isMemoUuid, isMemoRowVersion, isMemoTimestamp } from "./memos";

/** Format 2 extends the legacy snapshot families with independently validated Memo shards. */
export interface MemoSnapshotManifest {
  formatVersion: 2;
  counts: { projects: number; handoffs: number; events: number; artifacts: number; memos: number };
  memoDigests: Record<string, string>;
}
export interface LegacySnapshotManifest {
  formatVersion: 1;
  counts: { projects: number; handoffs: number; events: number; artifacts: number };
}
export type VersionedSnapshotManifest = LegacySnapshotManifest | MemoSnapshotManifest;
export interface MemoSnapshotEvent extends SnapshotEvent {
  memoId: string | null;
}
export interface MemoSnapshotShard {
  path: string;
  bytes: Uint8Array;
  digest: string;
}

function corrupt(message: string): Result<never> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

/** JSON.parse validates grammar first; this scan then checks decoded keys at every nesting level. */
export function parseUniqueSnapshotJson(text: string): Result<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return corrupt("Snapshot JSON is invalid");
  }
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const key: string = JSON.parse(text.slice(start, i + 1));
        const keys = stack[stack.length - 1];
        if (keys?.has(key)) return corrupt("Snapshot contains duplicate JSON keys");
        keys?.add(key);
      }
    }
  }
  return ok(value);
}

export function memoSnapshotPath(id: string): Result<string> {
  if (!isMemoUuid(id)) return corrupt("Memo snapshot UUID is not canonical");
  return ok(`memos/${id.slice(0, 2)}/${id}.json`);
}

export function memoIdFromSnapshotPath(path: string): Result<string> {
  const match = /^memos\/[0-9a-f]{2}\/([0-9a-f-]+)\.json$/.exec(path);
  const id = match?.[1];
  if (id === undefined) return corrupt("Memo snapshot path is not canonical");
  const canonical = memoSnapshotPath(id);
  if (!canonical.ok || canonical.value !== path) return corrupt("Memo snapshot path does not match its UUID shard");
  return ok(id);
}

export function parseVersionedSnapshotManifest(text: string): Result<VersionedSnapshotManifest> {
  const parsed = parseUniqueSnapshotJson(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!memoObject(value, ["formatVersion"], ["counts", "memoDigests"])) return corrupt("Snapshot manifest is invalid");
  if (value.formatVersion !== 1 && value.formatVersion !== 2)
    return err(appError("VAULT_SCHEMA_UNSUPPORTED", "Snapshot format is not supported"));
  const version2 = value.formatVersion === 2;
  if (!memoObject(value, version2 ? ["formatVersion", "counts", "memoDigests"] : ["formatVersion", "counts"]))
    return corrupt("Snapshot manifest fields are invalid");
  const countFields = ["projects", "handoffs", "events", "artifacts", ...(version2 ? ["memos"] : [])];
  if (
    !memoObject(value.counts, countFields) ||
    !Object.values(value.counts).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
  )
    return corrupt("Snapshot counts are invalid");
  if (version2) {
    if (value.memoDigests === null || typeof value.memoDigests !== "object" || Array.isArray(value.memoDigests))
      return corrupt("Memo digests must be an object");
    const digests = Object.entries(value.memoDigests);
    if (digests.length !== value.counts.memos) return corrupt("Memo digest count does not match the manifest");
    for (const [key, digest] of digests) {
      if (!memoIdFromSnapshotPath(key).ok || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
        return corrupt("Memo digest entry is invalid");
    }
    if (canonicalJson(value) !== text) return corrupt("Format-2 manifest bytes are not canonical");
  }
  return ok(value as unknown as VersionedSnapshotManifest);
}

export function serializeMemoSnapshot(memo: Memo): Result<MemoSnapshotShard> {
  const checked = parseMemoDetail(memo);
  if (!checked.ok) return corrupt("Memo snapshot fields are invalid");
  const path = memoSnapshotPath(memo.id);
  if (!path.ok) return path;
  const bytes = new TextEncoder().encode(canonicalJson(memo));
  return ok({ path: path.value, bytes, digest: createHash("sha256").update(bytes).digest("hex") });
}

/** Caller performs bounded regular-file reads without following symlinks before this pure check. */
export function parseMemoSnapshot(path: string, bytes: Uint8Array, digest: string): Result<Memo> {
  const id = memoIdFromSnapshotPath(path);
  if (!id.ok) return id;
  if (!/^[0-9a-f]{64}$/.test(digest) || createHash("sha256").update(bytes).digest("hex") !== digest)
    return corrupt("Memo snapshot digest does not match its raw bytes");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return corrupt("Memo snapshot is not valid UTF-8");
  }
  const parsed = parseUniqueSnapshotJson(text);
  if (!parsed.ok) return parsed;
  const memo = parseMemoDetail(parsed.value);
  if (!memo.ok || memo.value.id !== id.value)
    return corrupt("Memo snapshot record does not match its closed schema or path");
  if (canonicalJson(memo.value) !== text) return corrupt("Memo snapshot bytes are not canonical");
  return memo;
}

/** Legacy rows have no Memo association; format 2 requires an explicit nullable field. */
export function parseMemoEventAssociation(
  value: unknown,
  formatVersion: 1 | 2,
  memos: ReadonlyMap<string, Memo>,
): Result<MemoSnapshotEvent> {
  const fields = ["id", "handoffId", "eventType", "actorKind", "actorId", "rowVersion", "metadata", "createdAt"];
  if (!memoObject(value, [...fields, ...(formatVersion === 2 ? ["memoId"] : [])]))
    return corrupt("Snapshot event fields are invalid");
  if (
    !isMemoUuid(value.id) ||
    (value.handoffId !== null && !isMemoUuid(value.handoffId)) ||
    typeof value.eventType !== "string" ||
    !isEventType(value.eventType) ||
    typeof value.actorKind !== "string" ||
    !isActorKind(value.actorKind) ||
    (value.actorId !== null && typeof value.actorId !== "string") ||
    (value.rowVersion !== null && !isMemoRowVersion(value.rowVersion)) ||
    !isMemoTimestamp(value.createdAt) ||
    value.metadata === null ||
    typeof value.metadata !== "object" ||
    Array.isArray(value.metadata)
  )
    return corrupt("Snapshot event values are invalid");
  const memoId = formatVersion === 1 ? null : value.memoId;
  if (isMemoEventType(value.eventType)) {
    if (!isMemoUuid(memoId)) return corrupt("Memo event must identify a Memo");
    const memo = memos.get(memoId);
    const metadata = value.metadata;
    if (
      !memo ||
      !isMemoRowVersion(value.rowVersion) ||
      value.rowVersion > memo.rowVersion ||
      (value.eventType !== "MEMO_CREATED" && value.rowVersion < (value.eventType === "MEMO_REOPENED" ? 3 : 2)) ||
      value.handoffId !== null ||
      value.actorKind !== "user" ||
      value.actorId !== null ||
      metadata === null ||
      typeof metadata !== "object" ||
      !("projectId" in metadata) ||
      metadata.projectId !== memo.projectId ||
      !("memoId" in metadata) ||
      metadata.memoId !== memoId ||
      !("rowVersion" in metadata) ||
      metadata.rowVersion !== value.rowVersion ||
      !validMemoEventMetadata(metadata, value.eventType)
    )
      return corrupt("Memo event association is invalid");
    const resultingState =
      value.eventType === "MEMO_MARKED_DONE" ? "done" : value.eventType === "MEMO_DISMISSED" ? "dismissed" : "open";
    if (value.rowVersion === memo.rowVersion && memo.state !== resultingState)
      return corrupt("Latest Memo event state disagrees with its Memo");
  } else if (memoId !== null) return corrupt("Non-Memo event cannot identify a Memo");
  // The inventory reader reconciles full event histories and Project/Handoff references for other event kinds.
  return ok({ ...value, memoId } as unknown as MemoSnapshotEvent);
}

function validMemoEventMetadata(value: unknown, eventType: MemoEventType): boolean {
  const identity = ["projectId", "memoId", "rowVersion"];
  if (eventType === "MEMO_CREATED") {
    return memoObject(value, [...identity, "toState"]) && value.toState === "open" && value.rowVersion === 1;
  }
  if (eventType === "MEMO_UPDATED") {
    return (
      memoObject(value, [...identity, "changedFields"]) &&
      Array.isArray(value.changedFields) &&
      value.changedFields.length > 0 &&
      value.changedFields.every((field) => field === "title" || field === "body") &&
      new Set(value.changedFields).size === value.changedFields.length
    );
  }
  if (!memoObject(value, [...identity, "fromState", "toState"])) return false;
  switch (eventType) {
    case "MEMO_MARKED_DONE":
      return value.fromState === "open" && value.toState === "done";
    case "MEMO_DISMISSED":
      return value.fromState === "open" && value.toState === "dismissed";
    case "MEMO_REOPENED":
      return (value.fromState === "done" || value.fromState === "dismissed") && value.toState === "open";
  }
}

/** Publish each Memo's digest from the exact bytes that become its file content. */
export function snapshotFilesV2(data: SnapshotData): Result<{ files: SnapshotFile[]; manifest: MemoSnapshotManifest }> {
  const files = snapshotFiles({ projects: data.projects, handoffs: data.handoffs, events: [] }).filter(
    (file) => file.path !== "manifest.json" && file.path !== "events.jsonl",
  );
  const memoDigests: Record<string, string> = {};
  for (const memo of [...(data.memos ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const shard = serializeMemoSnapshot(memo);
    if (!shard.ok) return shard;
    if (Object.hasOwn(memoDigests, shard.value.path)) return corrupt("Duplicate Memo snapshot ID");
    memoDigests[shard.value.path] = shard.value.digest;
    files.push({ path: shard.value.path, content: Buffer.from(shard.value.bytes).toString("utf8") });
  }
  const events = data.events.map((event) => ({ ...event, memoId: event.memoId ?? null }));
  const manifest: MemoSnapshotManifest = {
    formatVersion: 2,
    counts: { ...snapshotManifest(data).counts, memos: data.memos?.length ?? 0 },
    memoDigests,
  };
  const valid = validateMemoInventory({ ...data, events }, manifest);
  if (!valid.ok) return valid;
  files.push({
    path: "events.jsonl",
    content: events
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      .map(canonicalJsonLine)
      .join(""),
  });
  files.push({ path: "manifest.json", content: canonicalJson(manifest) });
  return ok({ files, manifest });
}

/** Reconcile the whole Memo inventory and version-ordered history before any import. */
export function validateMemoInventory(data: SnapshotData, manifest: VersionedSnapshotManifest): Result<void> {
  const memos = data.memos ?? [];
  if (manifest.formatVersion === 1 && memos.length !== 0) return corrupt("Format 1 cannot contain Memos");
  if (manifest.formatVersion === 2 && memos.length !== manifest.counts.memos)
    return corrupt("Memo count does not match inventory");
  const projects = new Set(data.projects.map((project) => project.id));
  const owners = new Map<string, Memo>();
  for (const memo of memos) {
    if (!parseMemoDetail(memo).ok || owners.has(memo.id) || !projects.has(memo.projectId))
      return corrupt("Memo identity, fields or owning Project are invalid");
    owners.set(memo.id, memo);
  }
  if (manifest.formatVersion === 2) {
    const paths = memos.map((memo) => `memos/${memo.id.slice(0, 2)}/${memo.id}.json`);
    if (
      Object.keys(manifest.memoDigests).length !== paths.length ||
      paths.some((path) => !Object.hasOwn(manifest.memoDigests, path))
    )
      return corrupt("Memo digest inventory does not match its records");
  }
  const histories = new Map<string, MemoSnapshotEvent[]>();
  const ids = new Set<string>();
  for (const event of data.events) {
    if (ids.has(event.id)) return corrupt("Duplicate snapshot event ID");
    ids.add(event.id);
    if (!isMemoEventType(event.eventType)) {
      // Legacy event value validation is unchanged; only the new association is versioned.
      if (manifest.formatVersion === 1 ? Object.hasOwn(event, "memoId") : event.memoId !== null)
        return corrupt("Non-Memo event association is invalid for this format");
      continue;
    }
    const parsed = parseMemoEventAssociation(event, manifest.formatVersion, owners);
    if (!parsed.ok) return parsed;
    const id = parsed.value.memoId as string;
    const history = histories.get(id) ?? [];
    history.push(parsed.value);
    histories.set(id, history);
  }
  for (const memo of memos) {
    const events = (histories.get(memo.id) ?? []).sort((a, b) => (a.rowVersion as number) - (b.rowVersion as number));
    if (events.length !== memo.rowVersion) return corrupt("Memo history is incomplete");
    let state = "open";
    for (const [index, event] of events.entries()) {
      if (event.rowVersion !== index + 1) return corrupt("Memo history versions are not contiguous");
      if (index === 0) {
        if (event.eventType !== "MEMO_CREATED" || event.createdAt !== memo.createdAt)
          return corrupt("Memo creation event disagrees with its row");
      } else if (event.eventType === "MEMO_CREATED") return corrupt("Memo history repeats creation");
      else if (event.eventType === "MEMO_UPDATED") {
        if (state !== "open") return corrupt("Memo history edits closed content");
      } else {
        if (event.metadata.fromState !== state) return corrupt("Memo history transition is inconsistent");
        state = String(event.metadata.toState);
      }
    }
    if (state !== memo.state || events.at(-1)?.createdAt !== memo.updatedAt)
      return corrupt("Memo history does not describe its current row");
  }
  return ok(undefined);
}
