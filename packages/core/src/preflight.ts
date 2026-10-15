import { successEnvelope, type SuccessEnvelope } from "./protocol";

/**
 * Pure installation-preflight assessment (PFL-003, PFL-005, PFL-007).
 * Callers supply already observed facts. This module does not open files,
 * copy a database, or import SQLite. A completed report reuses the success
 * envelope, so ok stays true when the status exit is 75 or 78.
 */

export const PREFLIGHT_CONTRACT_VERSION = 1;

export const PREFLIGHT_STATUSES = [
  "fresh",
  "compatible",
  "upgrade_required",
  "recovery_required",
  "unsupported",
  "unverifiable",
] as const;

export type PreflightStatus = (typeof PREFLIGHT_STATUSES)[number];

export const PREFLIGHT_CHECK_IDS = [
  "home.state",
  "source.snapshot",
  "config.schema",
  "db.schema",
  "db.integrity",
  "vault.marker",
  "installation.identity",
  "upgrade.preparation",
] as const;

export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];
export type PreflightSeverity = "ok" | "warning" | "blocking";

export interface PreflightRecovery {
  message: string;
  suggestedCommand?: string;
}

export interface PreflightCheck {
  id: PreflightCheckId;
  severity: PreflightSeverity;
  message: string;
  recovery?: PreflightRecovery;
}

export interface PreflightReport {
  contractVersion: typeof PREFLIGHT_CONTRACT_VERSION;
  status: PreflightStatus;
  checks: PreflightCheck[];
}

export type PreflightReportIssue = "contract-version" | "status" | "catalog" | "severity" | "unexplained-ok";

export type ParsedPreflightReport = { ok: true; report: PreflightReport } | { ok: false; issue: PreflightReportIssue };

/** A logs-file is a regular file inside the logs directory, not a root-level namesake. */
export type PreflightResidueEntry =
  | { kind: "directory"; name: "logs" | "state" | "run" }
  | { kind: "logs-file"; name: string }
  | { kind: "unqualified"; scope: "root" | "logs" | "state" | "run"; name: string };

export type PreflightHomeFact =
  | { kind: "absent" }
  | { kind: "empty" }
  | { kind: "residue"; entries: readonly PreflightResidueEntry[] }
  | { kind: "unreadable" }
  | { kind: "broken-link" }
  | { kind: "non-directory" }
  | { kind: "partial" }
  | { kind: "unexplained" }
  | { kind: "installed" };

export type PreflightSnapshotFact =
  | { kind: "not-applicable" }
  | { kind: "unverified" }
  | { kind: "unavailable" }
  | { kind: "coherent"; staleFence: boolean };

export type PreflightConfigFact =
  | { kind: "not-applicable" }
  | { kind: "unverified" }
  | { kind: "absent" }
  | { kind: "supported" }
  | { kind: "invalid" }
  | { kind: "newer" }
  | { kind: "unsupported-format" };

export type PreflightDatabaseFact =
  | { kind: "not-applicable" }
  | { kind: "unverified" }
  | { kind: "absent" }
  | { kind: "current-ordered" }
  | { kind: "known-older-ordered"; preMemo: boolean }
  | { kind: "maximum-version-only" }
  | { kind: "memo-table-only" }
  | { kind: "corrupt" }
  | { kind: "invalid-structure" }
  | { kind: "newer" }
  | { kind: "unsupported-format" };

export type PreflightIntegrityFact =
  | { kind: "not-applicable" }
  | { kind: "unverified" }
  | { kind: "passed" }
  | { kind: "failed" };

export type PreflightVaultFact =
  | { kind: "not-applicable" }
  | { kind: "unverified" }
  | { kind: "absent" }
  | { kind: "supported" }
  | { kind: "malformed" }
  | { kind: "newer" }
  | { kind: "unsupported-format" };

export type PreflightIdentityFact =
  | { kind: "not-applicable" }
  | { kind: "unverified" }
  | { kind: "consistent"; row: "present" | "absent-optional" }
  | { kind: "inconsistent" };

/** Facts already observed by an adapter. Assessment does not collect them. */
export interface PreflightFacts {
  home: PreflightHomeFact;
  snapshot: PreflightSnapshotFact;
  config: PreflightConfigFact;
  database: PreflightDatabaseFact;
  integrity: PreflightIntegrityFact;
  vault: PreflightVaultFact;
  identity: PreflightIdentityFact;
}

const SEVERITIES = ["ok", "warning", "blocking"] as const;
const LOG_FILE_NAME = /^sorage\.log(?:\.[1-9][0-9]*)?$/;
const EXITS = {
  fresh: 0,
  compatible: 0,
  upgrade_required: 78,
  recovery_required: 78,
  unsupported: 78,
  unverifiable: 75,
} as const;

const INAPPLICABLE = "This check does not apply to the selected home.";
const UNVERIFIED = "This check could not be verified.";
const NO_INIT_AUTHORITY = "This status does not authorize initialization.";
const NO_DRILL_CLAIM =
  "This assessment does not confirm that an external drill already happened and does not approve an upgrade.";

export function preflightExitCode(status: PreflightStatus): 0 | 75 | 78 {
  return EXITS[status];
}

export function preflightEnvelope(report: PreflightReport, requestId: string): SuccessEnvelope<PreflightReport> {
  return successEnvelope(report, requestId);
}

export function assessPreflight(facts: PreflightFacts): PreflightReport {
  const status = decideStatus(facts);
  return {
    contractVersion: PREFLIGHT_CONTRACT_VERSION,
    status,
    checks: PREFLIGHT_CHECK_IDS.map((id) => renderCheck(id, facts, status)),
  };
}

export function parsePreflightReport(value: unknown): ParsedPreflightReport {
  if (
    !isRecord(value) ||
    value.contractVersion !== PREFLIGHT_CONTRACT_VERSION ||
    !exactKeys(value, ["contractVersion", "status", "checks"])
  ) {
    return { ok: false, issue: "contract-version" };
  }
  if (!isPreflightStatus(value.status)) return { ok: false, issue: "status" };
  if (!Array.isArray(value.checks) || value.checks.length !== PREFLIGHT_CHECK_IDS.length) {
    return { ok: false, issue: "catalog" };
  }
  const checks: PreflightCheck[] = [];
  for (let index = 0; index < PREFLIGHT_CHECK_IDS.length; index += 1) {
    const parsed = parseCheck(value.checks[index], PREFLIGHT_CHECK_IDS[index] as PreflightCheckId);
    if (!parsed.ok) return parsed;
    checks.push(parsed.check);
  }
  return { ok: true, report: { contractVersion: PREFLIGHT_CONTRACT_VERSION, status: value.status, checks } };
}

function decideStatus(facts: PreflightFacts): PreflightStatus {
  if (isFreshHome(facts.home)) return "fresh";
  if (facts.home.kind === "unreadable" || facts.home.kind === "broken-link" || facts.home.kind === "non-directory") {
    return "unverifiable";
  }
  if (hasNewerSchema(facts)) return "unsupported";
  if (hasUnsupportedFormat(facts)) return "unsupported";
  if (
    facts.home.kind === "partial" ||
    facts.home.kind === "unexplained" ||
    isInvalidResidue(facts.home) ||
    hasConclusiveRecovery(facts)
  ) {
    return "recovery_required";
  }
  if (hasUnresolvedMandatory(facts)) return "unverifiable";
  if (facts.database.kind === "known-older-ordered") return "upgrade_required";
  if (facts.database.kind === "current-ordered") return "compatible";
  return "unverifiable";
}

function renderCheck(id: PreflightCheckId, facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  if (id === "home.state") return homeCheck(facts);
  if (status === "fresh") return skipped(id, status, "inapplicable");
  switch (id) {
    case "source.snapshot":
      return snapshotCheck(facts, status);
    case "config.schema":
      return configCheck(facts, status);
    case "db.schema":
      return databaseCheck(facts, status);
    case "db.integrity":
      return integrityCheck(facts, status);
    case "vault.marker":
      return vaultCheck(facts, status);
    case "installation.identity":
      return identityCheck(facts, status);
    case "upgrade.preparation":
      return preparationCheck(facts, status);
    default:
      return skipped(id, status, "inapplicable");
  }
}

function homeCheck(facts: PreflightFacts): PreflightCheck {
  const home = facts.home;
  if (home.kind === "absent") return explained("home.state", "ok", "The selected home is absent.", NO_INIT_AUTHORITY);
  if (home.kind === "empty") return explained("home.state", "ok", "The selected home is empty.", NO_INIT_AUTHORITY);
  if (home.kind === "residue" && permittedResidue(home.entries)) {
    return explained(
      "home.state",
      "warning",
      "The selected home contains only permitted pre-initialization residue. That residue is not installation authority.",
      "Preserve the residue. This status does not authorize initialization.",
    );
  }
  if (home.kind === "unreadable")
    return obstacle("home.state", "The selected home cannot be read, so it is not fresh.");
  if (home.kind === "broken-link")
    return obstacle("home.state", "The selected home is a broken link, so it is not fresh.");
  if (home.kind === "non-directory")
    return obstacle("home.state", "The selected home is not a directory, so it is not fresh.");
  if (home.kind === "partial" || isInvalidResidue(home)) {
    return explained(
      "home.state",
      "blocking",
      "The selected home is recognizable partial installation state.",
      "Diagnose the inventory and obtain a bounded recovery decision. Do not initialize over this home.",
    );
  }
  if (home.kind === "unexplained") {
    return explained(
      "home.state",
      "blocking",
      "The selected home has a readable inventory that is not a known installation.",
      "Diagnose the inventory and obtain a bounded recovery decision. Do not initialize over this home.",
    );
  }
  return explained("home.state", "ok", "The selected home is present and readable.");
}

function snapshotCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  const snapshot = facts.snapshot;
  if (snapshot.kind === "coherent" && snapshot.staleFence) {
    return explained("source.snapshot", "warning", "A stale fence or lock was observed and was left untouched.");
  }
  if (snapshot.kind === "coherent")
    return explained("source.snapshot", "ok", "The observed source snapshot is coherent.");
  if (snapshot.kind === "unavailable") {
    return skipped("source.snapshot", status, "unavailable");
  }
  return skipped("source.snapshot", status, snapshot.kind === "not-applicable" ? "inapplicable" : "unverified");
}

function configCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  switch (facts.config.kind) {
    case "supported":
      return explained("config.schema", "ok", "The configuration schema is supported by this build.");
    case "absent":
      return explained(
        "config.schema",
        "blocking",
        "Configuration is missing from a recognizable installation.",
        recoveryGuidance(status),
      );
    case "invalid":
      return explained(
        "config.schema",
        "blocking",
        "The configuration structure is invalid.",
        recoveryGuidance(status),
      );
    case "newer":
      return explained(
        "config.schema",
        "blocking",
        "The configuration schema is newer than this build supports.",
        unsupportedGuidance(),
      );
    case "unsupported-format":
      return explained(
        "config.schema",
        "blocking",
        "The configuration format is readable and is not supported by this build.",
        unsupportedGuidance(),
      );
    default:
      return skipped("config.schema", status, facts.config.kind === "not-applicable" ? "inapplicable" : "unverified");
  }
}

function databaseCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  switch (facts.database.kind) {
    case "current-ordered":
      return explained(
        "db.schema",
        "ok",
        "The database has a complete ordered history this build supports, and no migration is required.",
      );
    case "known-older-ordered":
      return explained(
        "db.schema",
        "blocking",
        "The database has a valid known ordered history that is older than this build and needs migration.",
        status === "upgrade_required" ? NO_DRILL_CLAIM : recoveryGuidance(status),
      );
    case "maximum-version-only":
      return explained(
        "db.schema",
        unresolvedSeverity(status),
        "A maximum schema marker alone is not a complete ordered history, so it establishes neither compatibility nor a required upgrade.",
      );
    case "memo-table-only":
      return explained(
        "db.schema",
        unresolvedSeverity(status),
        "One optional domain record alone is not a complete ordered history, so it establishes neither compatibility nor a required upgrade.",
      );
    case "absent":
      return explained(
        "db.schema",
        "blocking",
        "The database is missing from a recognizable installation.",
        recoveryGuidance(status),
      );
    case "corrupt":
      return explained("db.schema", "blocking", "The database observation is corrupt.", recoveryGuidance(status));
    case "invalid-structure":
      return explained(
        "db.schema",
        "blocking",
        "The database structure is not valid for this build.",
        recoveryGuidance(status),
      );
    case "newer":
      return explained(
        "db.schema",
        "blocking",
        "The database schema is newer than this build supports.",
        unsupportedGuidance(),
      );
    case "unsupported-format":
      return explained(
        "db.schema",
        "blocking",
        "The database format is readable and is not supported by this build.",
        unsupportedGuidance(),
      );
    default:
      return skipped("db.schema", status, facts.database.kind === "not-applicable" ? "inapplicable" : "unverified");
  }
}

function integrityCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  if (facts.integrity.kind === "passed")
    return explained("db.integrity", "ok", "The inspected snapshot passed integrity checks.");
  if (facts.integrity.kind === "failed") {
    return explained(
      "db.integrity",
      "blocking",
      "Integrity checks failed on the inspected snapshot.",
      recoveryGuidance(status),
    );
  }
  return skipped("db.integrity", status, facts.integrity.kind === "not-applicable" ? "inapplicable" : "unverified");
}

function vaultCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  switch (facts.vault.kind) {
    case "supported":
      return explained("vault.marker", "ok", "The Vault marker is readable and uses a supported schema.");
    case "absent":
      return explained(
        "vault.marker",
        "blocking",
        "The Vault marker is missing from a recognizable installation.",
        recoveryGuidance(status),
      );
    case "malformed":
      return explained("vault.marker", "blocking", "The Vault marker is malformed.", recoveryGuidance(status));
    case "newer":
      return explained(
        "vault.marker",
        "blocking",
        "The Vault schema is newer than this build supports.",
        unsupportedGuidance(),
      );
    case "unsupported-format":
      return explained(
        "vault.marker",
        "blocking",
        "The Vault format is readable and is not supported by this build.",
        unsupportedGuidance(),
      );
    default:
      return skipped("vault.marker", status, facts.vault.kind === "not-applicable" ? "inapplicable" : "unverified");
  }
}

function identityCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  if (facts.identity.kind === "consistent" && facts.identity.row === "present") {
    return explained("installation.identity", "ok", "Installation identity agrees across the observed records.");
  }
  if (facts.identity.kind === "consistent") {
    return explained(
      "installation.identity",
      "ok",
      "Installation identity agrees where records are present. An optional identity record is absent and was not invented; that absence alone is not incomplete storage.",
    );
  }
  if (facts.identity.kind === "inconsistent") {
    return explained(
      "installation.identity",
      "blocking",
      "Installation identity does not agree across the observed records.",
      recoveryGuidance(status),
    );
  }
  return skipped(
    "installation.identity",
    status,
    facts.identity.kind === "not-applicable" ? "inapplicable" : "unverified",
  );
}

function preparationCheck(facts: PreflightFacts, status: PreflightStatus): PreflightCheck {
  if (isClosedHome(facts.home)) return skipped("upgrade.preparation", status, "unverified");
  if (status === "upgrade_required" && facts.database.kind === "known-older-ordered" && facts.database.preMemo) {
    return explained(
      "upgrade.preparation",
      "blocking",
      `Migration is required separately from preparation. Stop old writers, verify a backup with the old binary, and complete a separate restore drill before obtaining upgrade authority. ${NO_DRILL_CLAIM}`,
    );
  }
  if (status === "upgrade_required") {
    return explained(
      "upgrade.preparation",
      "blocking",
      `Migration is required. Pre-Memo backup verification and a separate restore drill do not apply. ${NO_DRILL_CLAIM}`,
    );
  }
  if (status === "compatible") {
    return explained(
      "upgrade.preparation",
      "ok",
      "No migration is required. Pre-Memo backup and restore preparation does not apply. This assessment does not confirm an external drill or approve later writes.",
    );
  }
  return skipped("upgrade.preparation", status, "inapplicable");
}

function skipped(
  id: PreflightCheckId,
  status: PreflightStatus,
  reason: "inapplicable" | "unverified" | "unavailable",
): PreflightCheck {
  const message =
    reason === "inapplicable"
      ? INAPPLICABLE
      : reason === "unavailable"
        ? "A coherent snapshot was not available."
        : UNVERIFIED;
  const severity: PreflightSeverity = status === "unverifiable" ? "blocking" : "warning";
  const recovery =
    status === "unverifiable"
      ? {
          message: "Preserve the installation, resolve the inspection obstacle, and run a new inspection.",
          suggestedCommand: "sorage preflight",
        }
      : { message: "This unfinished check does not authorize a write, an upgrade, or initialization." };
  return { id, severity, message, recovery };
}

function explained(
  id: PreflightCheckId,
  severity: PreflightSeverity,
  message: string,
  recoveryMessage?: string,
): PreflightCheck {
  if (recoveryMessage === undefined) return { id, severity, message };
  return { id, severity, message, recovery: { message: recoveryMessage } };
}

function obstacle(id: PreflightCheckId, message: string): PreflightCheck {
  return {
    id,
    severity: "blocking",
    message,
    recovery: {
      message:
        "Preserve the path, resolve the inspection obstacle, and run a new inspection. Do not treat the home as fresh.",
      suggestedCommand: "sorage preflight",
    },
  };
}

function recoveryGuidance(status: PreflightStatus): string {
  if (status === "unsupported") return unsupportedGuidance();
  if (status === "unverifiable")
    return "Preserve the installation, resolve the inspection obstacle, and run a new inspection.";
  return "Diagnose the storage and obtain a bounded recovery decision. Do not initialize over it.";
}

function unsupportedGuidance(): string {
  return "Use a build that supports this schema, or an explicitly authorized recovery path. Do not initialize over it or migrate it here.";
}

function unresolvedSeverity(status: PreflightStatus): PreflightSeverity {
  return status === "unverifiable" ? "blocking" : "warning";
}

function isFreshHome(home: PreflightHomeFact): boolean {
  if (home.kind === "absent" || home.kind === "empty") return true;
  return home.kind === "residue" && permittedResidue(home.entries);
}

function isInvalidResidue(home: PreflightHomeFact): boolean {
  return home.kind === "residue" && !permittedResidue(home.entries);
}

function isClosedHome(home: PreflightHomeFact): boolean {
  return home.kind === "unreadable" || home.kind === "broken-link" || home.kind === "non-directory";
}

function permittedResidue(entries: readonly PreflightResidueEntry[]): boolean {
  const seen = { logs: 0, state: 0, run: 0 };
  let logFiles = 0;
  for (const entry of entries) {
    if (entry.kind === "unqualified") return false;
    if (entry.kind === "logs-file") {
      if (!LOG_FILE_NAME.test(entry.name)) return false;
      logFiles += 1;
      continue;
    }
    seen[entry.name] += 1;
  }
  const present = seen.logs + seen.state + seen.run;
  if (present === 0 || seen.logs > 1 || seen.state > 1 || seen.run > 1) return false;
  return logFiles === 0 || seen.logs === 1;
}

function hasNewerSchema(facts: PreflightFacts): boolean {
  return facts.config.kind === "newer" || facts.database.kind === "newer" || facts.vault.kind === "newer";
}

function hasUnsupportedFormat(facts: PreflightFacts): boolean {
  return (
    facts.config.kind === "unsupported-format" ||
    facts.database.kind === "unsupported-format" ||
    facts.vault.kind === "unsupported-format"
  );
}

function hasConclusiveRecovery(facts: PreflightFacts): boolean {
  return (
    facts.config.kind === "absent" ||
    facts.config.kind === "invalid" ||
    facts.database.kind === "absent" ||
    facts.database.kind === "corrupt" ||
    facts.database.kind === "invalid-structure" ||
    facts.integrity.kind === "failed" ||
    facts.vault.kind === "absent" ||
    facts.vault.kind === "malformed" ||
    facts.identity.kind === "inconsistent"
  );
}

function hasUnresolvedMandatory(facts: PreflightFacts): boolean {
  const snapshotOpen = facts.snapshot.kind === "coherent";
  const configOpen = facts.config.kind === "supported";
  const databaseOpen = facts.database.kind === "current-ordered" || facts.database.kind === "known-older-ordered";
  const integrityOpen = facts.integrity.kind === "passed";
  const vaultOpen = facts.vault.kind === "supported";
  const identityOpen = facts.identity.kind === "consistent";
  return !snapshotOpen || !configOpen || !databaseOpen || !integrityOpen || !vaultOpen || !identityOpen;
}

function parseCheck(
  value: unknown,
  expectedId: PreflightCheckId,
): { ok: true; check: PreflightCheck } | { ok: false; issue: PreflightReportIssue } {
  if (!isRecord(value) || value.id !== expectedId || !exactKeys(value, ["id", "severity", "message"], ["recovery"])) {
    return { ok: false, issue: "catalog" };
  }
  if (!isSeverity(value.severity)) return { ok: false, issue: "severity" };
  if (value.severity === "ok" && !explainedMessage(value.message)) return { ok: false, issue: "unexplained-ok" };
  if (!explainedMessage(value.message)) return { ok: false, issue: "catalog" };
  if (value.recovery === undefined)
    return { ok: true, check: { id: expectedId, severity: value.severity, message: value.message } };
  const recovery = parseRecovery(value.recovery);
  if (recovery === null) return { ok: false, issue: "catalog" };
  return { ok: true, check: { id: expectedId, severity: value.severity, message: value.message, recovery } };
}

function parseRecovery(value: unknown): PreflightRecovery | null {
  if (!isRecord(value) || !exactKeys(value, ["message"], ["suggestedCommand"]) || !explainedMessage(value.message))
    return null;
  if (value.suggestedCommand === undefined) return { message: value.message };
  if (typeof value.suggestedCommand !== "string" || value.suggestedCommand.trim() === "") return null;
  return { message: value.message, suggestedCommand: value.suggestedCommand };
}

function explainedMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSeverity(value: unknown): value is PreflightSeverity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

function isPreflightStatus(value: unknown): value is PreflightStatus {
  return typeof value === "string" && (PREFLIGHT_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
