import { canonicalJson, type SnapshotFile, type SnapshotProject } from "./backup-snapshot";
import { isLowercaseSha256, isUtf8ExactText, sha256OfText, utf8ByteLength } from "./content";
import { appError, err, ok, type Result } from "./errors";
import { type SnapshotDataV4, snapshotFilesV4 } from "./handoff-reporting-snapshot";
import { memoObject } from "./memo-protocol";
import { type ExchangeSnapshotManifest, parseUniqueSnapshotJson } from "./memo-snapshot";
import { isMemoTimestamp, isMemoUuid } from "./memos";

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
}

export interface SnapshotDataV5 extends SnapshotDataV4 {
  exchanges: ExchangeSnapshotRecord[];
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
    }));
}

function serialize(records: ExchangeSnapshotRecord[]): string {
  const canonical = canonicalRecords(records);
  return canonicalJson({
    representation: FOUNDATION_REPRESENTATION,
    recordsSha256: sha256OfText(canonicalJson(canonical)),
    records: canonical,
  });
}

/** Validate only retained foundation fields. Working bytes and runtime authorities have no snapshot fields. */
export function validateExchangeInventory(
  records: unknown,
  projects: Pick<SnapshotProject, "id">[],
  count: number,
): Result<ExchangeSnapshotRecord[]> {
  if (!Array.isArray(records) || records.length !== count) {
    return corrupt("The manifest's Exchange count disagrees with its retained inventory.");
  }
  const projectsById = new Set(projects.map((project) => project.id));
  const exchangeIds = new Set<string>();
  const outcomeKeys = new Set<string>();
  for (const record of records) {
    if (
      !memoObject(record, [
        "id",
        "openingProjectId",
        "goal",
        "criteria",
        "createdAt",
        "members",
        "readRanges",
        "creationOutcomes",
      ]) ||
      !isMemoUuid(record.id) ||
      !isMemoUuid(record.openingProjectId) ||
      !isMemoTimestamp(record.createdAt) ||
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
    if (exchangeIds.has(record.id)) return corrupt("The Exchange inventory repeats an Exchange identity.");
    exchangeIds.add(record.id);
    const members = new Set<string>();
    for (const member of record.members) {
      if (!isMemoUuid(member) || !projectsById.has(member) || members.has(member)) {
        return corrupt("An Exchange member is repeated or does not identify an exported Project.");
      }
      members.add(member);
    }
    if (members.size < 2 || !members.has(record.openingProjectId)) {
      return corrupt("An Exchange foundation roster must include its opening Project and a peer.");
    }
    const ranges = new Map<string, Array<{ firstSeq: number; lastSeq: number }>>();
    for (const range of record.readRanges) {
      if (
        !memoObject(range, ["projectId", "firstSeq", "lastSeq"]) ||
        !isMemoUuid(range.projectId) ||
        !members.has(range.projectId) ||
        !positiveSequence(range.firstSeq) ||
        !positiveSequence(range.lastSeq) ||
        range.lastSeq < range.firstSeq
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
  if (value.representation !== FOUNDATION_REPRESENTATION) {
    return err(appError("VAULT_SCHEMA_UNSUPPORTED", "This Exchange snapshot representation is not supported."));
  }
  return ok((projects) => {
    const validated = validateExchangeInventory(value.records, projects, count);
    if (!validated.ok) return validated;
    if (serialize(validated.value) !== raw)
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

export function snapshotFilesV5(
  data: SnapshotDataV5,
): Result<{ files: SnapshotFile[]; manifest: ExchangeSnapshotManifest }> {
  const inventory = validateExchangeInventory(data.exchanges, data.projects, data.exchanges.length);
  if (!inventory.ok) return inventory;
  const older = snapshotFilesV4(data);
  if (!older.ok) return older;
  const manifest: ExchangeSnapshotManifest = {
    ...older.value.manifest,
    formatVersion: 5,
    counts: { ...older.value.manifest.counts, exchanges: inventory.value.length },
  };
  return ok({
    files: [
      ...older.value.files.map((file) =>
        file.path === "manifest.json" ? { ...file, content: canonicalJson(manifest) } : file,
      ),
      { path: EXCHANGE_SNAPSHOT_FILE, content: serialize(inventory.value) },
    ],
    manifest,
  });
}
