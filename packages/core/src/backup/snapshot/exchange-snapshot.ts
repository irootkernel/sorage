import { createHash } from "node:crypto";
import { compareSnapshotStrings, handoffShardPath, type SnapshotFile, type SnapshotProject } from "./backup-snapshot";
import {
  channelContentFilePath,
  channelSnapshotPath,
  proveChannelContentBytes,
  validateSnapshotChannelShard,
} from "./channel-snapshot";
import { runV5SnapshotCodecs, type SnapshotCodecContext, type SnapshotDomainCodec } from "./codec-snapshot";
import { isLowercaseSha256, isUtf8ExactText } from "../../content/content";
import { serializeMemoSnapshotV3, validateSnapshotMemoContent } from "./content-snapshot";
import { appError, err, ok, type Result } from "../../shared/errors";
import { canonicalExchangeCollaboration, validateExchangeCollaboration } from "./exchange-collaboration-snapshot";
import type { ExchangeLifecycle } from "../../exchange/exchange-lifecycle";
import {
  canonicalExchangeLifecycle,
  exchangeWorkTimeline,
  openExchangeLifecycle,
  validateExchangeLifecycleEffects,
} from "./exchange-lifecycle-snapshot";
import { validateExchangeNoticeInventory } from "./exchange-notice-snapshot";
import type { ExchangeNoticeInventory } from "../../exchange/exchange-notices";
import type { ExchangeCollaboration } from "../../exchange/exchanges";
import {
  type SnapshotDataV4,
  type SnapshotHandoffV4,
  validateReportingSnapshotEvent,
  validateSnapshotHandoffV4,
} from "./handoff-reporting-snapshot";
import { type ExchangeSnapshotManifest, memoContentFilePath } from "./memo-snapshot";
import { isCanonicalUtcTimestamp, isCanonicalUuid } from "../../primitives/identity";
import { canonicalJson, canonicalJsonLine, parseUniqueSnapshotJson } from "../../primitives/json";
import { memoObject, sha256OfText, utf8ByteLength } from "../../primitives/validation";

export const EXCHANGE_SNAPSHOT_FILE = "exchanges.json";

export interface ExchangeReadRange {
  projectId: string;
  firstSeq: number;
  lastSeq: number;
}

export interface ExchangeCreationOutcome {
  projectId: string;
  operationId: string;
  fingerprint: string;
}

export interface ExchangeSnapshotRecord {
  id: string;
  openingProjectId: string;
  goal: string;
  criteria: string[];
  createdAt: string;
  members: string[];
  readRanges: ExchangeReadRange[];
  creationOutcomes: ExchangeCreationOutcome[];
  collaboration?: ExchangeCollaboration;
  lifecycle?: ExchangeLifecycle;
  notices?: ExchangeNoticeInventory;
}

export type ExchangeSnapshotRepresentation = "foundation" | "collaboration" | "lifecycle" | "notices";

export interface SnapshotDataV5 extends SnapshotDataV4 {
  exchanges: ExchangeSnapshotRecord[];
  exchangeRepresentation?: ExchangeSnapshotRepresentation;
}

/** Capability discriminator for the first Exchange record family within global format 5. */
const FOUNDATION_REPRESENTATION = "foundation";

function corrupt(message: string): Result<never> {
  return err(appError("VAULT_INTEGRITY_ERROR", message));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isUtf8ExactText(value);
}

function positiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalRecords(records: ExchangeSnapshotRecord[]): ExchangeSnapshotRecord[] {
  return [...records]
    .sort((a, b) => compare(a.id, b.id))
    .map((record) => ({
      ...record,
      members: [...record.members].sort(compare),
      readRanges: [...record.readRanges].sort((a, b) => compare(a.projectId, b.projectId) || a.firstSeq - b.firstSeq),
      creationOutcomes: [...record.creationOutcomes].sort(
        (a, b) => compare(a.projectId, b.projectId) || compare(a.operationId, b.operationId),
      ),
      ...(record.collaboration ? { collaboration: canonicalExchangeCollaboration(record.collaboration) } : {}),
      ...(record.lifecycle ? { lifecycle: canonicalExchangeLifecycle(record.lifecycle) } : {}),
      ...(record.notices
        ? {
            notices: {
              ...record.notices,
              openConnectionIssues: [...record.notices.openConnectionIssues].sort(compare),
            },
          }
        : {}),
    }));
}

function serialize(records: ExchangeSnapshotRecord[], representation: ExchangeSnapshotRepresentation): string {
  const canonical = canonicalRecords(records);
  return canonicalJson({
    representation,
    recordsSha256: sha256OfText(canonicalJson(canonical)),
    records: canonical,
  });
}

/** Validate only retained foundation fields. Working bytes and runtime authorities have no snapshot fields. */
export function validateExchangeInventory(
  records: unknown,
  projects: Pick<SnapshotProject, "id">[],
  count: number,
  representation?: ExchangeSnapshotRepresentation,
): Result<ExchangeSnapshotRecord[]> {
  if (!Array.isArray(records) || records.length !== count) {
    return corrupt("The manifest's Exchange count disagrees with its retained inventory.");
  }
  const projectsById = new Set(projects.map((project) => project.id));
  const exchangeIds = new Set<string>();
  const outcomeKeys = new Set<string>();
  for (const record of records) {
    if (
      !memoObject(
        record,
        ["id", "openingProjectId", "goal", "criteria", "createdAt", "members", "readRanges", "creationOutcomes"],
        ["collaboration", "lifecycle", "notices"],
      ) ||
      !isCanonicalUuid(record.id) ||
      !isCanonicalUuid(record.openingProjectId) ||
      !isCanonicalUtcTimestamp(record.createdAt) ||
      !nonemptyText(record.goal) ||
      !Array.isArray(record.criteria) ||
      record.criteria.length === 0 ||
      !record.criteria.every(nonemptyText) ||
      utf8ByteLength(record.goal) + record.criteria.reduce((size, item) => size + utf8ByteLength(item), 0) > 8192 ||
      !Array.isArray(record.members) ||
      !Array.isArray(record.readRanges) ||
      !Array.isArray(record.creationOutcomes)
    ) {
      return corrupt("An Exchange foundation record has invalid fields.");
    }
    const collaboration = Object.hasOwn(record, "collaboration");
    const lifecyclePresent = Object.hasOwn(record, "lifecycle");
    const noticesPresent = Object.hasOwn(record, "notices");
    if (
      (representation !== undefined &&
        (collaboration !== (representation !== "foundation") ||
          lifecyclePresent !== (representation === "lifecycle" || representation === "notices") ||
          noticesPresent !== (representation === "notices"))) ||
      (lifecyclePresent && !collaboration) ||
      (noticesPresent && !lifecyclePresent)
    ) {
      return corrupt("An Exchange collaboration record has invalid fields or associations.");
    }
    if (exchangeIds.has(record.id)) return corrupt("The Exchange inventory repeats an Exchange identity.");
    exchangeIds.add(record.id);
    const members = new Set<string>();
    for (const member of record.members) {
      if (!isCanonicalUuid(member) || !projectsById.has(member) || members.has(member)) {
        return corrupt("An Exchange member is repeated or does not identify an exported Project.");
      }
      members.add(member);
    }
    if (members.size < 2 || !members.has(record.openingProjectId)) {
      return corrupt("An Exchange foundation roster must include its opening Project and a peer.");
    }
    const lifecycle =
      lifecyclePresent &&
      record.collaboration &&
      typeof record.collaboration === "object" &&
      "lastSeq" in record.collaboration
        ? openExchangeLifecycle(
            record.lifecycle,
            members,
            record.openingProjectId,
            record.collaboration.lastSeq,
            noticesPresent,
          )
        : null;
    if (
      (lifecyclePresent && lifecycle === null) ||
      (collaboration &&
        !validateExchangeCollaboration(
          record.collaboration,
          record.id,
          members,
          lifecycle ?? undefined,
          noticesPresent,
        ))
    ) {
      return corrupt("An Exchange collaboration record has invalid fields or associations.");
    }
    if (lifecycle) {
      const collaboration = record.collaboration as ExchangeCollaboration;
      const timeline = exchangeWorkTimeline(lifecycle, collaboration);
      if (
        !validateExchangeLifecycleEffects(lifecycle, collaboration, members, record.criteria, timeline) ||
        (noticesPresent &&
          !validateExchangeNoticeInventory(record.notices, lifecycle, collaboration, timeline.committedHeads))
      )
        return corrupt("An Exchange collaboration record has invalid fields or associations.");
    }
    const ranges = new Map<string, Array<{ firstSeq: number; lastSeq: number }>>();
    for (const range of record.readRanges) {
      if (
        !memoObject(range, ["projectId", "firstSeq", "lastSeq"]) ||
        !isCanonicalUuid(range.projectId) ||
        !members.has(range.projectId) ||
        !positiveSequence(range.firstSeq) ||
        !positiveSequence(range.lastSeq) ||
        range.lastSeq < range.firstSeq ||
        (collaboration && range.lastSeq > (record.collaboration as ExchangeCollaboration).lastSeq)
      ) {
        return corrupt("An Exchange read range has invalid fields or membership.");
      }
      const existing = ranges.get(range.projectId) ?? [];
      existing.push({ firstSeq: range.firstSeq, lastSeq: range.lastSeq });
      ranges.set(range.projectId, existing);
    }
    for (const memberRanges of ranges.values()) {
      memberRanges.sort((a, b) => a.firstSeq - b.firstSeq);
      for (let index = 1; index < memberRanges.length; index++) {
        const previous = memberRanges[index - 1];
        const current = memberRanges[index];
        if (previous && current && current.firstSeq - previous.lastSeq <= 1) {
          return corrupt("Exchange read ranges must be disjoint, with gaps preserved.");
        }
      }
    }
    for (const outcome of record.creationOutcomes) {
      if (
        !memoObject(outcome, ["projectId", "operationId", "fingerprint"]) ||
        outcome.projectId !== record.openingProjectId ||
        !nonemptyText(outcome.operationId) ||
        typeof outcome.fingerprint !== "string" ||
        !isLowercaseSha256(outcome.fingerprint)
      ) {
        return corrupt("An Exchange creation outcome has invalid identity or fingerprint fields.");
      }
      const key = JSON.stringify([outcome.projectId, outcome.operationId]);
      if (outcomeKeys.has(key)) return corrupt("The Exchange inventory repeats a creation operation identity.");
      outcomeKeys.add(key);
    }
  }
  return ok(records as ExchangeSnapshotRecord[]);
}

export type ExchangeSnapshotValidator = (projects: Pick<SnapshotProject, "id">[]) => Result<ExchangeSnapshotRecord[]>;

/** Admit the required representation before reading the other snapshot families. */
export function openExchangeSnapshot(raw: string, count: number): Result<ExchangeSnapshotValidator> {
  const parsed = parseUniqueSnapshotJson(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!memoObject(value, ["representation", "recordsSha256", "records"]) || !nonemptyText(value.representation)) {
    return corrupt("The Exchange snapshot has invalid framing.");
  }
  if (
    value.representation !== FOUNDATION_REPRESENTATION &&
    value.representation !== "collaboration" &&
    value.representation !== "lifecycle" &&
    value.representation !== "notices"
  ) {
    return err(appError("VAULT_SCHEMA_UNSUPPORTED", "This Exchange snapshot representation is not supported."));
  }
  const representation = value.representation;
  return ok((projects) => {
    const validated = validateExchangeInventory(value.records, projects, count, representation);
    if (!validated.ok) return validated;
    if (serialize(validated.value, representation) !== raw)
      return corrupt("The Exchange inventory digest or canonical bytes disagree.");
    return validated;
  });
}

export function parseExchangeSnapshot(
  raw: string,
  projects: Pick<SnapshotProject, "id">[],
  count: number,
): Result<ExchangeSnapshotRecord[]> {
  const opened = openExchangeSnapshot(raw, count);
  return opened.ok ? opened.value(projects) : opened;
}

const preparedMemoState = new WeakMap<
  SnapshotCodecContext,
  { files: SnapshotFile[]; memoDigests: Record<string, string>; contentDigests: Record<string, string> }
>();
const preparedChannelState = new WeakMap<
  SnapshotCodecContext,
  { files: SnapshotFile[]; contentDigests: Record<string, string> }
>();
const preparedExchangeState = new WeakMap<
  SnapshotCodecContext,
  { records: ExchangeSnapshotRecord[]; representation: ExchangeSnapshotRepresentation }
>();

const projectsV5Codec: SnapshotDomainCodec<SnapshotDataV5> = {
  id: "projects",
  validate: () => ok(undefined),
  files: (data) => ok([{ path: "projects.json", content: canonicalJson(data.projects) }]),
  counts: (data) => ({ projects: data.projects.length }),
};

const handoffsV5Codec: SnapshotDomainCodec<SnapshotDataV5> = {
  id: "handoffs",
  validate: (data) => {
    const handoffsById = new Map<string, SnapshotHandoffV4>();
    for (const handoff of data.handoffs) {
      const valid = validateSnapshotHandoffV4(handoff);
      if (!valid.ok) return valid;
      if (!handoffsById.has(handoff.id)) handoffsById.set(handoff.id, handoff);
    }
    for (const event of data.events) {
      const valid = validateReportingSnapshotEvent(event, handoffsById);
      if (!valid.ok) return valid;
    }
    return ok(undefined);
  },
  files: (data) => {
    const byId = [...data.handoffs].sort((a, b) => compareSnapshotStrings(a.id, b.id));
    return ok(byId.map((handoff) => ({ path: handoffShardPath(handoff.id), content: canonicalJson(handoff) })));
  },
  counts: (data) => ({
    handoffs: data.handoffs.length,
    artifacts: data.handoffs.filter((handoff) => handoff.artifact !== null).length,
  }),
};

const memosV5Codec: SnapshotDomainCodec<SnapshotDataV5> = {
  id: "memos",
  validate: (data, context) => {
    const content = validateSnapshotMemoContent(data);
    if (!content.ok) return content;
    const files: SnapshotFile[] = [];
    const memoDigests: Record<string, string> = {};
    const contentDigests: Record<string, string> = {};
    for (const carried of data.memoContentFiles ?? []) {
      const carriedPath = memoContentFilePath(carried.memoId, carried.contentId);
      if (!carriedPath.ok) return carriedPath;
      if (context.carriedContent.has(carriedPath.value)) return corrupt("Duplicate Memo content file identity");
      const digest = createHash("sha256").update(carried.bytes).digest("hex");
      context.carriedContent.set(carriedPath.value, carried.bytes);
      context.contentDigests[carriedPath.value] = digest;
      contentDigests[carriedPath.value] = digest;
    }
    const memos = data.memos ?? [];
    for (const memo of [...memos].sort((a, b) => compareSnapshotStrings(a.id, b.id))) {
      const shard = serializeMemoSnapshotV3(memo);
      if (!shard.ok) return shard;
      if (Object.hasOwn(memoDigests, shard.value.path)) return corrupt("Duplicate Memo snapshot ID");
      memoDigests[shard.value.path] = shard.value.digest;
      context.memoDigests[shard.value.path] = shard.value.digest;
      files.push({ path: shard.value.path, content: Buffer.from(shard.value.bytes).toString("utf8") });
      if (memo.bodyContent.kind === "file-backed") {
        context.referencedContent.add(memo.bodyContent.contentPath);
        const bytes = context.carriedContent.get(memo.bodyContent.contentPath);
        if (bytes === undefined) {
          return corrupt("A file-backed Memo shard names a content file the export does not carry");
        }
        if (
          bytes.byteLength !== memo.bodyContent.sizeBytes ||
          context.contentDigests[memo.bodyContent.contentPath] !== memo.bodyContent.sha256
        ) {
          return corrupt("A file-backed Memo shard disagrees with its carried content file");
        }
        files.push({ path: memo.bodyContent.contentPath, content: bytes });
      }
    }
    preparedMemoState.set(context, { files, memoDigests, contentDigests });
    return ok(undefined);
  },
  files: (_data, context) => ok(preparedMemoState.get(context)?.files ?? []),
  counts: (data) => ({ memos: (data.memos ?? []).length }),
  digests: (_data, context) => {
    const state = preparedMemoState.get(context);
    return state ? { memoDigests: state.memoDigests, contentDigests: state.contentDigests } : {};
  },
};

const channelsV5Codec: SnapshotDomainCodec<SnapshotDataV5> = {
  id: "channels",
  validate: (data, context) => {
    const files: SnapshotFile[] = [];
    const contentDigests: Record<string, string> = {};
    for (const carried of data.channelContentFiles ?? []) {
      const carriedPath = channelContentFilePath(carried.channelId, carried.contentId);
      if (!carriedPath.ok) return carriedPath;
      if (context.carriedContent.has(carriedPath.value)) return corrupt("Duplicate Channel content file identity");
      const proof = proveChannelContentBytes(carried.bytes);
      if (!proof.ok) return proof;
      const digest = createHash("sha256").update(carried.bytes).digest("hex");
      context.carriedContent.set(carriedPath.value, carried.bytes);
      context.contentDigests[carriedPath.value] = digest;
      contentDigests[carriedPath.value] = digest;
    }
    const channels = data.channels ?? [];
    const channelIds = new Set<string>();
    for (const channel of [...channels].sort((a, b) => compareSnapshotStrings(a.id, b.id))) {
      const shard = validateSnapshotChannelShard(channel);
      if (!shard.ok) return shard;
      if (channelIds.has(channel.id)) return corrupt("Duplicate Channel snapshot ID");
      channelIds.add(channel.id);
      const shardPath = channelSnapshotPath(channel.id);
      if (!shardPath.ok) return shardPath;
      files.push({ path: shardPath.value, content: canonicalJson(channel) });
      for (const message of channel.messages) {
        if (!("contentPath" in message.bodyContent)) continue;
        const body = message.bodyContent;
        if (context.referencedContent.has(body.contentPath)) {
          return corrupt("Two file-backed records name one content file");
        }
        context.referencedContent.add(body.contentPath);
        const bytes = context.carriedContent.get(body.contentPath);
        if (bytes === undefined) {
          return corrupt("A file-backed Channel message names a content file the export does not carry");
        }
        if (bytes.byteLength !== body.sizeBytes || context.contentDigests[body.contentPath] !== body.sha256) {
          return corrupt("A file-backed Channel message disagrees with its carried content file");
        }
        files.push({ path: body.contentPath, content: bytes });
      }
    }
    if (context.carriedContent.size !== context.referencedContent.size) {
      return corrupt("The export carries a content file no shard names");
    }
    for (const contentPath of context.carriedContent.keys()) {
      if (!context.referencedContent.has(contentPath)) {
        return corrupt("The export carries a content file no shard names");
      }
    }
    preparedChannelState.set(context, { files, contentDigests });
    return ok(undefined);
  },
  files: (_data, context) => ok(preparedChannelState.get(context)?.files ?? []),
  counts: (data) => ({ channels: (data.channels ?? []).length }),
  digests: (_data, context) => {
    const state = preparedChannelState.get(context);
    return state ? { contentDigests: state.contentDigests } : {};
  },
};

const eventsV5Codec: SnapshotDomainCodec<SnapshotDataV5> = {
  id: "events",
  validate: () => ok(undefined),
  files: (data) => {
    const events = data.events
      .map((event) => ({ ...event, memoId: event.memoId ?? null }))
      .sort((a, b) => compareSnapshotStrings(a.createdAt, b.createdAt) || compareSnapshotStrings(a.id, b.id))
      .map(canonicalJsonLine)
      .join("");
    return ok([{ path: "events.jsonl", content: events }]);
  },
  counts: (data) => ({ events: data.events.length }),
};

const exchangesV5Codec: SnapshotDomainCodec<SnapshotDataV5> = {
  id: "exchanges",
  validationOrder: -1,
  placement: "after-manifest",
  validate: (data, context) => {
    const representation = data.exchangeRepresentation ?? FOUNDATION_REPRESENTATION;
    const inventory = validateExchangeInventory(data.exchanges, data.projects, data.exchanges.length, representation);
    if (!inventory.ok) return inventory;
    preparedExchangeState.set(context, { records: inventory.value, representation });
    return ok(undefined);
  },
  files: (_data, context) => {
    const state = preparedExchangeState.get(context);
    if (!state) return corrupt("Exchange snapshot state was not prepared.");
    return ok([{ path: EXCHANGE_SNAPSHOT_FILE, content: serialize(state.records, state.representation) }]);
  },
  counts: (data) => ({ exchanges: data.exchanges.length }),
};

const V5_SNAPSHOT_CODECS: readonly SnapshotDomainCodec<SnapshotDataV5>[] = [
  projectsV5Codec,
  handoffsV5Codec,
  memosV5Codec,
  channelsV5Codec,
  eventsV5Codec,
  exchangesV5Codec,
];

export function snapshotFilesV5(
  data: SnapshotDataV5,
): Result<{ files: SnapshotFile[]; manifest: ExchangeSnapshotManifest }> {
  return runV5SnapshotCodecs(data, V5_SNAPSHOT_CODECS);
}
