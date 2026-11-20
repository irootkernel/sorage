import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../../src/backup-commands";
import { canonicalJson } from "../../src/backup-snapshot";
import { sha256OfText } from "../../src/content";
import {
  EXCHANGE_SNAPSHOT_FILE,
  parseExchangeSnapshot,
  type SnapshotDataV5,
  snapshotFilesV5,
} from "../../src/exchange-snapshot";
import { snapshotFilesV4 } from "../../src/handoff-reporting-snapshot";
import { parseVersionedSnapshotManifest } from "../../src/memo-snapshot";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const EXCHANGE = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-11-20T00:00:00.000Z";

function fixture(): SnapshotDataV5 {
  return {
    projects: [
      {
        id: OWNER,
        slug: "owner",
        displayName: "Owner",
        description: null,
        status: "active",
        createdAt: DATE,
        updatedAt: DATE,
        bindings: [],
      },
      {
        id: PEER,
        slug: "peer",
        displayName: "Peer",
        description: null,
        status: "active",
        createdAt: DATE,
        updatedAt: DATE,
        bindings: [],
      },
    ],
    handoffs: [],
    events: [],
    exchanges: [
      {
        id: EXCHANGE,
        openingProjectId: OWNER,
        goal: "Collect exact observations",
        criteria: ["Report the result", "Keep the evidence scoped"],
        createdAt: DATE,
        members: [PEER, OWNER],
        readRanges: [
          { projectId: PEER, firstSeq: 6, lastSeq: 6 },
          { projectId: PEER, firstSeq: 2, lastSeq: 4 },
        ],
        creationOutcomes: [{ projectId: OWNER, operationId: "synthetic-create", fingerprint: sha256OfText("input") }],
      },
    ],
  };
}

function inventory(data: SnapshotDataV5): string {
  const built = snapshotFilesV5(data);
  if (!built.ok) throw new Error(built.error.message);
  return String(built.value.files.find((file) => file.path === EXCHANGE_SNAPSHOT_FILE)?.content);
}

describe("the global format-5 Exchange inventory", () => {
  it("refuses canonical collaboration progress above its sequence floor while accepting historical foundation ranges", () => {
    const data = fixture();
    const base = data.exchanges[0];
    if (!base) throw new Error("missing fixture Exchange");
    expect(parseExchangeSnapshot(inventory(data), data.projects, 1).ok).toBe(true);
    const collaboration = {
      lastSeq: 5,
      messages: [],
      requests: [],
      reports: [],
      acceptances: [],
      materials: [],
      operations: [],
    };
    const records = [
      {
        ...base,
        members: [...base.members].sort(),
        readRanges: [...base.readRanges].sort((a, b) => a.firstSeq - b.firstSeq),
        collaboration,
      },
    ];
    const raw = canonicalJson({
      representation: "collaboration",
      recordsSha256: sha256OfText(canonicalJson(records)),
      records,
    });
    expect(parseExchangeSnapshot(raw, data.projects, 1)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
    expect(snapshotFilesV5({ ...data, exchangeRepresentation: "collaboration", exchanges: records })).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
    collaboration.lastSeq = 6;
    const matching = inventory({ ...data, exchangeRepresentation: "collaboration", exchanges: records });
    expect(parseExchangeSnapshot(matching, data.projects, 1).ok).toBe(true);
  });

  it("is deterministic without changing the legacy writer or its manifest framing", () => {
    const data = fixture();
    const before = inventory(data);
    const exchange = data.exchanges[0];
    if (!exchange) throw new Error("missing fixture Exchange");
    exchange.members.reverse();
    exchange.readRanges.reverse();
    expect(inventory(data)).toBe(before);
    expect(parseExchangeSnapshot(before, data.projects, 1)).toEqual({ ok: true, value: data.exchanges });
    const built = snapshotFilesV5(data);
    if (!built.ok) throw new Error(built.error.message);
    expect(Object.keys(built.value.manifest).sort()).toEqual([
      "contentDigests",
      "counts",
      "formatVersion",
      "memoDigests",
    ]);
    expect(parseVersionedSnapshotManifest(canonicalJson(built.value.manifest))).toEqual({
      ok: true,
      value: built.value.manifest,
    });
    expect(validateSnapshot(data, built.value.manifest).ok).toBe(true);
    const older = snapshotFilesV4(data);
    if (!older.ok) throw new Error(older.error.message);
    expect(older.value.manifest.formatVersion).toBe(4);
    expect(older.value.files.some((file) => file.path === EXCHANGE_SNAPSHOT_FILE)).toBe(false);
  });

  it("requires a complete canonical inventory even when there are no Exchange rows", () => {
    const data = { ...fixture(), exchanges: [] };
    const raw = inventory(data);
    expect(parseExchangeSnapshot(raw, data.projects, 0)).toEqual({ ok: true, value: [] });
    expect(parseExchangeSnapshot(raw, data.projects, 1)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
    expect(parseExchangeSnapshot(raw.trim(), data.projects, 0)).toMatchObject({
      ok: false,
      error: { code: "VAULT_INTEGRITY_ERROR" },
    });
  });

  it("distinguishes an unsupported required representation from malformed current records", () => {
    const data = fixture();
    const raw = inventory(data);
    expect(
      parseExchangeSnapshot(raw.replace('"foundation"', '"later-workflow-records"'), data.projects, 1),
    ).toMatchObject({
      ok: false,
      error: { code: "VAULT_SCHEMA_UNSUPPORTED" },
    });
    for (const candidate of [
      raw.replace('"foundation"', "3"),
      raw.replace('"goal":', '"leaseClaims": [], "goal":'),
      raw.replace('"goal":', '"noticeClaims": [], "goal":'),
      raw.replace('"goal":', '"projectBindings": [], "goal":'),
      raw.replace('"goal":', '"goal": "duplicate", "goal":'),
      raw.replace('"goal":', '"body": "disposable", "goal":'),
      raw.replace('"synthetic-create"', '"different-operation"'),
      raw.replace(PEER, "ffffffff-ffff-4fff-8fff-ffffffffffff"),
    ]) {
      expect(parseExchangeSnapshot(candidate, data.projects, 1)).toMatchObject({
        ok: false,
        error: { code: "VAULT_INTEGRITY_ERROR" },
      });
    }
  });

  it("enforces the workflow text budget and never merges an invalid range", () => {
    const data = fixture();
    const exchange = data.exchanges[0];
    if (!exchange) throw new Error("missing fixture Exchange");
    const overBudget = { ...data, exchanges: [{ ...exchange, goal: "é".repeat(4096) }] };
    expect(snapshotFilesV5(overBudget)).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
    expect(
      snapshotFilesV5({
        ...data,
        exchanges: [
          { ...exchange, readRanges: [...exchange.readRanges, { projectId: PEER, firstSeq: 4, lastSeq: 8 }] },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "VAULT_INTEGRITY_ERROR" } });
  });
});
