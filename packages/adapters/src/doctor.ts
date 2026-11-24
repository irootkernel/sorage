import type { CheckOutcome, DoctorCheckId, DoctorPorts } from "@sorage/core";
import { bindingsDoctorChecks } from "./doctor-checks-bindings";
import { configDoctorChecks } from "./doctor-checks-config";
import { runtimeDoctorChecks } from "./doctor-checks-runtime";
import { storageDoctorChecks } from "./doctor-checks-storage";
import { vaultDoctorChecks } from "./doctor-checks-vault";
import { createDoctorContext, type DoctorContext, type NodeDoctorPortsOptions } from "./doctor-context";
import { attachRecovery } from "./doctor-recoveries";

export type { NodeDoctorPortsOptions } from "./doctor-context";

/**
 * Check handlers keyed by `DoctorCheckId` in exact `DOCTOR_CATALOG_0_1` order.
 */
const DOCTOR_CHECKS: Record<DoctorCheckId, (context: DoctorContext) => CheckOutcome> = {
  "home.permissions": configDoctorChecks["home.permissions"],
  "config.schema": configDoctorChecks["config.schema"],
  "config.lock": configDoctorChecks["config.lock"],
  "vault.marker": vaultDoctorChecks["vault.marker"],
  "vault.gitattributes": vaultDoctorChecks["vault.gitattributes"],
  "vault.writable": vaultDoctorChecks["vault.writable"],
  "db.integrity": storageDoctorChecks["db.integrity"],
  "db.pendingIntents": storageDoctorChecks["db.pendingIntents"],
  "db.migrations": storageDoctorChecks["db.migrations"],
  "artifacts.checksums": storageDoctorChecks["artifacts.checksums"],
  "content.checksums": storageDoctorChecks["content.checksums"],
  "bindings.exist": bindingsDoctorChecks["bindings.exist"],
  "bindings.nested": bindingsDoctorChecks["bindings.nested"],
  "bindings.ambiguous": bindingsDoctorChecks["bindings.ambiguous"],
  "daemon.reachable": runtimeDoctorChecks["daemon.reachable"],
  "daemon.port": runtimeDoctorChecks["daemon.port"],
  "token.permissions": runtimeDoctorChecks["token.permissions"],
  "service.installed": runtimeDoctorChecks["service.installed"],
  "backup.schedule": runtimeDoctorChecks["backup.schedule"],
  "git.state": runtimeDoctorChecks["git.state"],
  "platform.tcc": vaultDoctorChecks["platform.tcc"],
};

/**
 * The production doctor probes over the live installation: every check the M1
 * snapshot can perform, with the recovery guidance of section 35 attached to every
 * non-ok outcome.
 */
export function createNodeDoctorPorts(options: NodeDoctorPortsOptions = {}): DoctorPorts {
  const context = createDoctorContext(options);

  return {
    // TASK-118 K1/Z2: only a confirmed ENOENT is pre-initialization. A present
    // but unreadable file, a denied parent traversal, or a path fault (a
    // non-regular entry, a dangling symlink, or a symlink loop) at the path all
    // run the catalog with their own repair.
    initialized() {
      return context.configurationState().kind !== "absent";
    },

    probe(id: DoctorCheckId): CheckOutcome {
      return attachRecovery(id, DOCTOR_CHECKS[id](context), context.vaultState);
    },

    beginSession() {
      context.beginSession();
    },

    close() {
      context.close();
    },
  };
}
