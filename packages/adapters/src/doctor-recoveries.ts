import {
  type AppError,
  type CheckOutcome,
  CONFIG_ACCESS_REPAIR,
  CONFIG_PATH_REPAIR,
  type DoctorCheckId,
  errorSpec,
} from "@sorage/core";

export const CONFIG_REPAIR = "sorage config validate, then repair the reported keys";
export const VAULT_GITATTRIBUTES =
  "Backfill both files with sorage init --reconfigure --non-interactive; set the git configuration in the Vault repository";
export const GITIGNORE_ENTRY =
  "Add the missing staging/ entry to .gitignore by hand; reconfiguration creates only a missing .gitignore";
export const GITATTRIBUTES_AND_GITIGNORE =
  "Backfill .gitattributes with sorage init --reconfigure --non-interactive, and add the missing staging/ entry to .gitignore by hand; reconfiguration creates only a missing .gitignore";
export const POLICY_PATH_REPAIR =
  "Repair the policy file path and its permissions; reconfiguration cannot backfill a symlink, directory, or unreadable file";
export const POLICY_PATH_AND_RECONFIGURE =
  "Repair the unsafe or unreadable policy path and backfill the missing policy file or .gitattributes line with sorage init --reconfigure --non-interactive; reconfiguration cannot backfill a symlink, directory, or unreadable file";
export const POLICY_PATH_AND_GITIGNORE =
  "Repair the unsafe or unreadable policy path and add the missing staging/ entry to .gitignore by hand";
export const POLICY_PATH_RECONFIGURE_AND_GITIGNORE =
  "Repair the unsafe or unreadable policy path, backfill the missing policy file or .gitattributes line with sorage init --reconfigure --non-interactive, and add the missing staging/ entry to .gitignore by hand; reconfiguration cannot backfill a symlink, directory, or unreadable file";

export const RECOVERIES: Record<DoctorCheckId, string> = {
  "home.permissions": CONFIG_ACCESS_REPAIR,
  "config.schema": CONFIG_REPAIR,
  "config.lock": "Remove ~/.sorage/run/config.lock once no sorage process is running",
  "vault.marker":
    "Check the configured vault.path and confirm its volume is mounted; restore a verified backup into a fresh installation; adopt a foreign Vault only through the audited restore",
  "vault.gitattributes": VAULT_GITATTRIBUTES,
  "vault.writable": "Fix the directory permissions, or remount the volume read-write",
  "db.integrity": "Restore from ~/.sorage/state/backups/, or sorage backup restore into a fresh installation",
  "db.pendingIntents":
    "Inspect the ARTIFACT_INTEGRITY_FAILED events for the affected Handoffs and restore them from backup",
  "db.migrations": "Install the matching sorage build; remove a stale ~/.sorage/run/migration.lock",
  "artifacts.checksums": "sorage vault verify, then restore the affected Handoff from backup",
  "content.checksums": "sorage vault verify, then restore the affected records from backup",
  "bindings.exist":
    "sorage project bind <project> --dir <path> for an unbound Project, or sorage project unbind <project> --dir <the recorded directory this warning names> for a binding whose directory vanished",
  "bindings.nested": "Pass --as <project-slug> wherever the deepest match is not the intended Project",
  "bindings.ambiguous": "sorage project unbind the aliased path, or always pass --as <project-slug> from it",
  "platform.tcc": "Grant Full Disk Access to the invoking terminal, or keep the Vault under ~/.sorage",
  "daemon.reachable": "sorage daemon start, or delete a stale ~/.sorage/run/daemon.json",
  "token.permissions": "sorage token rotate --as-user",
  "daemon.port": "Change server.port in the configuration, then restart the daemon",
  "service.installed": "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/xyz.rootkernel.sorage.plist",
  "backup.schedule": "sorage backup run, then read sorage backup status",
  "git.state": "Resolve the repository state manually; Sorage never rebases or merges",
};

/** The checks whose result depends on the Vault opening (TASK-118, section 3.4). */
export const VAULT_DEPENDENT = new Set<DoctorCheckId>([
  "vault.marker",
  "vault.gitattributes",
  "vault.writable",
  "artifacts.checksums",
  "content.checksums",
  "platform.tcc",
]);

/** The recovery a Vault-open refusal carries, or null when it is a different failure. */
export function openRefusalRecovery(error: AppError): string | null {
  if (typeof error.details?.vaultPath !== "string") return null;
  return error.recovery?.suggestedCommand ?? errorSpec(error.code).recovery?.suggestedCommand ?? null;
}

export function withRecovery(outcome: CheckOutcome, recovery: string): CheckOutcome {
  if (outcome.severity === "ok") return outcome;
  return { ...outcome, recovery: { suggestedCommand: recovery } };
}

export function ok(message: string): CheckOutcome {
  return { severity: "ok", message };
}

export function warning(message: string): CheckOutcome {
  return { severity: "warning", message, recovery: undefined };
}

export function blocking(message: string): CheckOutcome {
  return { severity: "blocking", message, recovery: undefined };
}

/**
 * Section 35 attaches its recovery guidance to every non-ok outcome
 * (TASK-118): an explicit branch recovery wins, a Vault-dependent check whose
 * Vault cannot open carries that refusal's own recovery, and otherwise the
 * static catalog text applies. A static `sorage vault verify` is therefore
 * only reachable while the Vault actually opens.
 */
export function attachRecovery(
  id: DoctorCheckId,
  outcome: CheckOutcome,
  vaultState: () =>
    | { kind: "opens" }
    | { kind: "refused"; message: string; recovery: string }
    | { kind: "unconfigured" },
): CheckOutcome {
  if (outcome.severity === "ok") return outcome;
  if (outcome.recovery !== undefined) return outcome;
  if (VAULT_DEPENDENT.has(id)) {
    const opened = vaultState();
    if (opened.kind === "refused") {
      return { ...outcome, recovery: { suggestedCommand: opened.recovery } };
    }
  }
  return { ...outcome, recovery: { suggestedCommand: RECOVERIES[id] } };
}

export { CONFIG_ACCESS_REPAIR, CONFIG_PATH_REPAIR };
