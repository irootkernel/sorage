/**
 * The doctor check catalog (INIT-014, INIT-017, NFR-010): the 0.1 snapshot held
 * exactly fourteen check identifiers, and the catalog grows only as later
 * milestones land; milestone 0.2 adds `daemon.port`, and milestone 0.3 adds
 * `service.installed`, `backup.schedule`, and `git.state`.
 * Each check carries a dotted id, a severity of ok, warning, or blocking, a message, and
 * an optional recovery. The catalog is a versioned part of the CLI JSON contract;
 * adding, renaming, or re-scoping a check is a contract change. Before
 * initialization every installation-dependent check reports blocking with the
 * message "Sorage is not initialized" and `sorage init` as its recovery, and only
 * `config.schema` names the expected configuration file.
 */
export type DoctorSeverity = "ok" | "warning" | "blocking";

export interface DoctorCheck {
  id: string;
  severity: DoctorSeverity;
  message: string;
  recovery?: { suggestedCommand: string } | undefined;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

export const DOCTOR_CATALOG_0_1 = [
  "home.permissions",
  "config.schema",
  "config.lock",
  "vault.marker",
  "vault.gitattributes",
  "vault.writable",
  "db.integrity",
  "db.pendingIntents",
  "db.migrations",
  "artifacts.checksums",
  "bindings.exist",
  "bindings.nested",
  "bindings.ambiguous",
  "daemon.reachable",
  "daemon.port",
  "token.permissions",
  "service.installed",
  "backup.schedule",
  "git.state",
  "platform.tcc",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CATALOG_0_1)[number];

/** The worst severity each catalog id can report, from section 35. */
export const DOCTOR_CATALOG_SEVERITY: Record<DoctorCheckId, DoctorSeverity> = {
  "home.permissions": "blocking",
  "config.schema": "blocking",
  "config.lock": "warning",
  "vault.marker": "blocking",
  "vault.gitattributes": "warning",
  "vault.writable": "blocking",
  "db.integrity": "blocking",
  "db.pendingIntents": "warning",
  "db.migrations": "blocking",
  "artifacts.checksums": "blocking",
  "bindings.exist": "warning",
  "bindings.nested": "warning",
  "bindings.ambiguous": "warning",
  "daemon.reachable": "warning",
  "platform.tcc": "warning",
  "token.permissions": "blocking",
  "daemon.port": "warning",
  "service.installed": "warning",
  "backup.schedule": "warning",
  "git.state": "warning",
};

export type CheckOutcome = {
  severity: DoctorSeverity;
  message: string;
  recovery?: { suggestedCommand: string } | undefined;
};

export interface DoctorPorts {
  /** True when a configuration file exists, valid or not. */
  initialized(): boolean;
  /** Performs one catalog check against the live installation. */
  probe(id: DoctorCheckId): CheckOutcome;
}

/** Runs the milestone-scoped catalog and returns the report in stable order. */
export function runDoctor(ports: DoctorPorts, configFile: string): DoctorReport {
  if (!ports.initialized()) return notInitializedReport(configFile);
  return { checks: DOCTOR_CATALOG_0_1.map((id) => ({ id, ...ports.probe(id) })) };
}

/** True when at least one check is blocking, which is the non-zero exit condition. */
export function hasBlockingCheck(report: DoctorReport): boolean {
  return report.checks.some((check) => check.severity === "blocking");
}

/** The pre-initialization report: every check blocking, one named path. */
export function notInitializedReport(configFile: string): DoctorReport {
  return {
    checks: DOCTOR_CATALOG_0_1.map((id) => ({
      id,
      severity: "blocking" as const,
      message:
        id === "config.schema"
          ? `Sorage is not initialized; expected configuration file: ${configFile}`
          : "Sorage is not initialized",
      recovery: { suggestedCommand: "sorage init" },
    })),
  };
}
