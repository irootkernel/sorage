import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCTOR_CATALOG_0_1, DOCTOR_CATALOG_SEVERITY, notInitializedReport, type DoctorReport } from "../../src/doctor";

/**
 * Contract snapshot for the doctor catalog (INIT-017): the committed golden files
 * pin the M1 check identifiers with their worst severities and the complete
 * pre-initialization report shape, and an unreviewed change fails this suite.
 */
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

describe("doctor catalog contract snapshot", () => {
  it("pins the M1 catalog ids with their worst severities", () => {
    const catalog = DOCTOR_CATALOG_0_1.map((id) => ({ id, worst: DOCTOR_CATALOG_SEVERITY[id] }));
    const golden = readFileSync(`${goldenDir}doctor-catalog.json`, "utf8");
    expect(JSON.stringify(catalog, null, 2)).toBe(golden.trimEnd());
  });

  it("pins the complete pre-initialization report", () => {
    const report: DoctorReport = notInitializedReport("/tmp/sorage-golden-home/config.yaml");
    const golden = readFileSync(`${goldenDir}doctor-pre-init.json`, "utf8");
    expect(JSON.stringify(report, null, 2)).toBe(golden.trimEnd());
  });
});
