import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PREFLIGHT_CHECK_IDS,
  PREFLIGHT_CONTRACT_VERSION,
  PREFLIGHT_STATUSES,
  assessPreflight,
  preflightEnvelope,
  preflightExitCode,
  type PreflightFacts,
} from "../../src/preflight";

/**
 * Contract snapshot for the version-1 preflight report (PFL-003, PFL-007).
 * The golden pins contractVersion, catalog order, severity, recovery, status,
 * and the status exit map. Doctor and envelope goldens stay unchanged.
 */
const goldenPath = fileURLToPath(new URL("./golden/preflight-report.json", import.meta.url));

const residueFacts: PreflightFacts = {
  home: {
    kind: "residue",
    entries: [
      { kind: "directory", name: "logs" },
      { kind: "directory", name: "state" },
      { kind: "directory", name: "run" },
      { kind: "logs-file", name: "sorage.log" },
      { kind: "logs-file", name: "sorage.log.1" },
      { kind: "logs-file", name: "sorage.log.12" },
    ],
  },
  snapshot: { kind: "coherent", staleFence: false },
  config: { kind: "supported" },
  database: { kind: "current-ordered" },
  integrity: { kind: "passed" },
  vault: { kind: "supported" },
  identity: { kind: "consistent", row: "present" },
};

describe("preflight report contract snapshot", () => {
  it("pins the version-1 catalog, exits, severity, recovery, and status", () => {
    const report = assessPreflight(residueFacts);
    const snapshot = {
      contractVersion: PREFLIGHT_CONTRACT_VERSION,
      catalog: PREFLIGHT_CHECK_IDS,
      exits: Object.fromEntries(PREFLIGHT_STATUSES.map((status) => [status, preflightExitCode(status)])),
      report,
    };
    const golden = readFileSync(goldenPath, "utf8");
    expect(JSON.stringify(snapshot, null, 2)).toBe(golden.trimEnd());
    expect(report.status).toBe("fresh");
    expect(report.checks[0]).toMatchObject({ id: "home.state", severity: "warning" });
    expect(report.checks[0]?.recovery?.message).toContain("does not authorize initialization");
    const blocking = assessPreflight({ ...residueFacts, home: { kind: "unreadable" } });
    expect(preflightExitCode(blocking.status)).toBe(75);
    expect(preflightEnvelope(blocking, "2f0ac9a0-0000-4000-8000-000000000097").ok).toBe(true);
  });
});
