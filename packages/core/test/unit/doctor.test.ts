import { describe, expect, it } from "vitest";
import {
  DOCTOR_CATALOG_0_1,
  DOCTOR_CATALOG_SEVERITY,
  hasBlockingCheck,
  notInitializedReport,
  runDoctor,
  type CheckOutcome,
  type DoctorPorts,
} from "../../src/doctor";

describe("the doctor catalog", () => {
  it("holds exactly sixteen unique check identifiers after 0.3 adds backup.schedule", () => {
    expect(DOCTOR_CATALOG_0_1).toHaveLength(16);
    expect(new Set(DOCTOR_CATALOG_0_1).size).toBe(16);
  });

  it("contains the 0.3 backup check and none of the later unscheduled ones", () => {
    expect(DOCTOR_CATALOG_0_1).toContain("backup.schedule");
    const laterIds = ["daemon.reachable", "token.permissions", "service.installed", "git.state"];
    for (const id of laterIds) {
      expect(DOCTOR_CATALOG_0_1).not.toContain(id);
    }
  });

  it("declares the section-35 worst severity for every id", () => {
    expect(DOCTOR_CATALOG_SEVERITY["home.permissions"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["config.schema"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["config.lock"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["vault.marker"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["vault.gitattributes"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["vault.writable"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["db.integrity"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["db.pendingIntents"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["db.migrations"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["artifacts.checksums"]).toBe("blocking");
    expect(DOCTOR_CATALOG_SEVERITY["bindings.exist"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["bindings.nested"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["bindings.ambiguous"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["platform.tcc"]).toBe("warning");
    expect(DOCTOR_CATALOG_SEVERITY["backup.schedule"]).toBe("warning");
  });
});

describe("the pre-initialization report", () => {
  it("marks every check blocking with the init recovery", () => {
    const report = notInitializedReport("/tmp/expected/config.yaml");
    expect(report.checks).toHaveLength(16);
    for (const check of report.checks) {
      expect(check.severity).toBe("blocking");
      if (check.id !== "config.schema") {
        expect(check.message).toBe("Sorage is not initialized");
      } else {
        expect(check.message).toContain("Sorage is not initialized");
      }
      expect(check.recovery).toEqual({ suggestedCommand: "sorage init" });
    }
    expect(hasBlockingCheck(report)).toBe(true);
  });

  it("names the configuration file only on config.schema", () => {
    const report = notInitializedReport("/tmp/expected/config.yaml");
    for (const check of report.checks) {
      if (check.id === "config.schema") {
        expect(check.message).toBe("Sorage is not initialized; expected configuration file: /tmp/expected/config.yaml");
      } else {
        expect(check.message).not.toContain("/tmp/expected/config.yaml");
      }
    }
  });
});

describe("runDoctor", () => {
  it("emits the initialized probes in catalog order", () => {
    const outcome: CheckOutcome = { severity: "ok", message: "fine" };
    const seen: string[] = [];
    const ports: DoctorPorts = {
      initialized: () => true,
      probe: (id) => {
        seen.push(id);
        return outcome;
      },
    };
    const report = runDoctor(ports, "/tmp/any/config.yaml");
    expect(seen).toEqual([...DOCTOR_CATALOG_0_1]);
    expect(report.checks.every((check) => check.severity === "ok")).toBe(true);
    expect(hasBlockingCheck(report)).toBe(false);
  });

  it("short-circuits to the pre-initialization report", () => {
    const ports: DoctorPorts = {
      initialized: () => false,
      probe: () => {
        throw new Error("probes must not run before initialization");
      },
    };
    const report = runDoctor(ports, "/tmp/expected/config.yaml");
    expect(report.checks).toHaveLength(16);
    expect(report.checks.every((check) => check.severity === "blocking")).toBe(true);
  });
});
