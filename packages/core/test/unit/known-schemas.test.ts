import { describe, expect, it } from "vitest";
import { productionMigrationPlan } from "../../../adapters/src/sqlite/migrations";
import {
  admitAppliedHistory,
  admitKnownAppliedHistory,
  KNOWN_SCHEMA_HISTORY,
  knownSchemaMaximum,
  schemaSurfaceFloor,
  schemaSurfaceSupports,
} from "../../src/known-schemas";

const ROWS = (versions: number[]) =>
  versions.map((version) => ({
    version,
    name: (KNOWN_SCHEMA_HISTORY.find((entry) => entry.version === version) as { name: string }).name,
  }));

describe("the central known-schema inventory", () => {
  it("matches the combined production migration plan exactly", () => {
    const plan = productionMigrationPlan();
    const combined = [
      ...plan.migrations.map((migration) => ({ version: migration.version, name: migration.name })),
      ...plan.rebuilds.map((migration) => ({ version: migration.version, name: migration.name })),
    ].sort((a, b) => a.version - b.version);
    expect(combined).toEqual([...KNOWN_SCHEMA_HISTORY]);
    expect(knownSchemaMaximum()).toBe(12);
  });

  it("admits a complete applied prefix", () => {
    expect(admitKnownAppliedHistory(ROWS([1, 2, 3, 4, 5, 6, 7, 8])).kind).toBe("ok");
    expect(admitKnownAppliedHistory(ROWS([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).kind).toBe("ok");
    expect(admitKnownAppliedHistory(ROWS([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).kind).toBe("ok");
    expect(admitKnownAppliedHistory(ROWS([1, 2, 3, 4])).kind).toBe("ok");
    expect(admitKnownAppliedHistory([]).kind).toBe("ok");
  });

  it("refuses an unknown forward applied version as STORAGE_SCHEMA_UNSUPPORTED", () => {
    const refused = admitKnownAppliedHistory([
      ...ROWS([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      { version: knownSchemaMaximum() + 1, name: "future" },
    ]);
    expect(refused.kind).toBe("unsupported");
    if (refused.kind === "unsupported") expect(refused.error.code).toBe("STORAGE_SCHEMA_UNSUPPORTED");
  });

  it("refuses a hole below the applied maximum as an integrity failure", () => {
    const hole = admitKnownAppliedHistory(ROWS([1, 2, 4, 5, 6, 7, 8, 9]));
    expect(hole.kind).toBe("integrity");
    if (hole.kind === "integrity") expect(hole.error.code).toBe("STORAGE_INTEGRITY_ERROR");
  });

  it("refuses a version/name mismatch and a duplicate version", () => {
    const mismatch = admitAppliedHistory([{ version: 2, name: "wrong-name" }], KNOWN_SCHEMA_HISTORY.slice(0, 3));
    expect(mismatch.kind).toBe("integrity");
    const duplicate = admitAppliedHistory(
      [ROWS([1])[0] as { version: number; name: string }, ROWS([1])[0] as { version: number; name: string }],
      KNOWN_SCHEMA_HISTORY,
    );
    expect(duplicate.kind).toBe("integrity");
  });
});

describe("per-surface legacy prefix eligibility", () => {
  it("scopes send replay to histories from version 4 on", () => {
    expect(schemaSurfaceFloor("send-replay")).toBe(4);
    expect(schemaSurfaceSupports("send-replay", 3)).toBe(false);
    expect(schemaSurfaceSupports("send-replay", 4)).toBe(true);
    expect(schemaSurfaceSupports("send-replay", 8)).toBe(true);
    expect(schemaSurfaceSupports("send-replay", 9)).toBe(true);
    expect(schemaSurfaceSupports("send-replay", 10)).toBe(true);
    expect(schemaSurfaceSupports("send-replay", 11)).toBe(true);
    expect(schemaSurfaceSupports("send-replay", 12)).toBe(true);
  });

  it("scopes Memo surfaces to histories that contain the Memo domain", () => {
    expect(schemaSurfaceFloor("memo")).toBe(7);
    expect(schemaSurfaceSupports("memo", 6)).toBe(false);
    expect(schemaSurfaceSupports("memo", 7)).toBe(true);
    expect(schemaSurfaceSupports("memo", 8)).toBe(true);
    expect(schemaSurfaceSupports("memo", 9)).toBe(true);
    expect(schemaSurfaceSupports("memo", 10)).toBe(true);
    expect(schemaSurfaceSupports("memo", 11)).toBe(true);
    expect(schemaSurfaceSupports("memo", 12)).toBe(true);
  });

  it("keeps Channel surfaces nonexistent before the Channel migration", () => {
    expect(schemaSurfaceFloor("channel")).toBe(11);
    expect(schemaSurfaceSupports("channel", 8)).toBe(false);
    expect(schemaSurfaceSupports("channel", 10)).toBe(false);
    expect(schemaSurfaceSupports("channel", 11)).toBe(true);
    expect(schemaSurfaceSupports("channel", 12)).toBe(true);
  });

  it("lets the operational and preflight surfaces read every known version", () => {
    expect(schemaSurfaceSupports("operational", 1)).toBe(true);
    expect(schemaSurfaceSupports("operational", 8)).toBe(true);
    expect(schemaSurfaceSupports("preflight", 8)).toBe(true);
    expect(schemaSurfaceSupports("operational", 9)).toBe(true);
    expect(schemaSurfaceSupports("preflight", 9)).toBe(true);
    expect(schemaSurfaceSupports("operational", 10)).toBe(true);
    expect(schemaSurfaceSupports("preflight", 10)).toBe(true);
    expect(schemaSurfaceSupports("operational", 11)).toBe(true);
    expect(schemaSurfaceSupports("preflight", 11)).toBe(true);
    expect(schemaSurfaceSupports("operational", 12)).toBe(true);
    expect(schemaSurfaceSupports("preflight", 12)).toBe(true);
  });
});
