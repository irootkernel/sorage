import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckOutcome, verifyVaultPolicyFiles } from "@sorage/core";
import type { DoctorContext } from "./doctor-context";
import {
  blocking,
  CONFIG_REPAIR,
  GITATTRIBUTES_AND_GITIGNORE,
  GITIGNORE_ENTRY,
  ok,
  POLICY_PATH_AND_GITIGNORE,
  POLICY_PATH_AND_RECONFIGURE,
  POLICY_PATH_RECONFIGURE_AND_GITIGNORE,
  POLICY_PATH_REPAIR,
  RECOVERIES,
  VAULT_GITATTRIBUTES,
  warning,
  withRecovery,
} from "./doctor-recoveries";

/** One policy-file read: present, absent, or present at an unsafe/unreadable path. */
type PolicyRead = { kind: "present"; text: string } | { kind: "missing" } | { kind: "unsafe" };

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function readPolicyFile(path: string): PolicyRead {
  try {
    if (!lstatSync(path).isFile()) return { kind: "unsafe" };
    return { kind: "present", text: readFileSync(path, "utf8") };
  } catch (error) {
    return isNotFound(error) ? { kind: "missing" } : { kind: "unsafe" };
  }
}

export const vaultDoctorChecks: Record<
  "vault.marker" | "vault.gitattributes" | "vault.writable" | "platform.tcc",
  (context: DoctorContext) => CheckOutcome
> = {
  "vault.marker"(context) {
    const state = context.configurationState();
    if (state.kind !== "valid") {
      return withRecovery(
        blocking("The Vault marker cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const opened = context.vaultState();
    if (opened.kind === "refused") return blocking(opened.message);
    if (opened.kind === "unconfigured") {
      return withRecovery(blocking("The Vault marker cannot be checked without a valid configuration."), CONFIG_REPAIR);
    }
    return ok("The Vault marker matches this installation.");
  },

  "vault.gitattributes"(context) {
    const state = context.configurationState();
    if (state.kind !== "valid") {
      return withRecovery(
        warning("The Vault policy files cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const opened = context.vaultState();
    if (opened.kind === "refused") return warning(opened.message);
    const vault = context.vaultPath(state.config);
    if (vault === null) {
      return withRecovery(
        warning("The Vault policy files cannot be checked without a valid configuration."),
        CONFIG_REPAIR,
      );
    }
    const attributes = readPolicyFile(join(vault, ".gitattributes"));
    const ignore = readPolicyFile(join(vault, ".gitignore"));
    // K8/K13: collect every finding from both files — including an unsafe or
    // unreadable path — before choosing one recovery, so each state names
    // every action it actually needs.
    const findings: string[] = [];
    let pathIssue = false;
    let attributesIssue = false;
    let ignoreEntryIssue = false;
    let ignoreMissing = false;
    if (attributes.kind === "unsafe") {
      findings.push(".gitattributes is unreadable or unsafe at its path.");
      pathIssue = true;
    } else if (attributes.kind === "missing") {
      findings.push(".gitattributes is missing from the Vault.");
      attributesIssue = true;
    } else {
      // The required lines and their stated order, exactly as `vault verify`
      // and `backup verify` assert them (VLT-024, BKP-022, section 6).
      const problems = verifyVaultPolicyFiles(attributes.text, null).filter((problem) =>
        problem.startsWith(".gitattributes"),
      );
      findings.push(...problems);
      attributesIssue = problems.length > 0;
    }
    if (ignore.kind === "unsafe") {
      findings.push(".gitignore is unreadable or unsafe at its path.");
      pathIssue = true;
    } else if (ignore.kind === "missing") {
      findings.push(".gitignore is missing from the Vault.");
      ignoreMissing = true;
    } else {
      const problems = verifyVaultPolicyFiles(null, ignore.text).filter((problem) => problem.startsWith(".gitignore"));
      findings.push(...problems);
      ignoreEntryIssue = problems.length > 0;
    }
    if (findings.length === 0) {
      return ok("The Vault policy files carry every required line in its stated order.");
    }
    const needsReconfigure = attributesIssue || ignoreMissing;
    let recovery: string;
    if (!pathIssue) {
      recovery =
        needsReconfigure && ignoreEntryIssue
          ? GITATTRIBUTES_AND_GITIGNORE
          : needsReconfigure
            ? VAULT_GITATTRIBUTES
            : GITIGNORE_ENTRY;
    } else if (needsReconfigure && ignoreEntryIssue) {
      recovery = POLICY_PATH_RECONFIGURE_AND_GITIGNORE;
    } else if (needsReconfigure) {
      recovery = POLICY_PATH_AND_RECONFIGURE;
    } else if (ignoreEntryIssue) {
      recovery = POLICY_PATH_AND_GITIGNORE;
    } else {
      recovery = POLICY_PATH_REPAIR;
    }
    return withRecovery(warning(findings.join(" ")), recovery);
  },

  "vault.writable"(context) {
    const state = context.configurationState();
    if (state.kind !== "valid") {
      return withRecovery(
        blocking("The Vault cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    const opened = context.vaultState();
    if (opened.kind === "refused") {
      return blocking("The Vault root, artifacts/, or staging/ is not writable by this user.");
    }
    const vault = context.vaultPath(state.config);
    if (vault === null) {
      return withRecovery(blocking("The Vault cannot be checked without a valid configuration."), CONFIG_REPAIR);
    }
    try {
      for (const directory of [vault, join(vault, "artifacts"), join(vault, "staging")]) {
        accessSync(directory, constants.W_OK);
      }
    } catch {
      return withRecovery(
        blocking("The Vault root, artifacts/, or staging/ is not writable by this user."),
        RECOVERIES["vault.writable"],
      );
    }
    return ok("The Vault root, artifacts/, and staging/ are writable.");
  },

  "platform.tcc"(context) {
    const state = context.configurationState();
    const vault = context.vaultPath(state.kind === "valid" ? state.config : null);
    if (vault === null) {
      return withRecovery(
        warning("Platform readability cannot be checked without a valid configuration."),
        context.configurationRecovery(state),
      );
    }
    try {
      accessSync(vault, constants.R_OK);
    } catch {
      return warning("The Vault is not readable without a macOS privacy prompt.");
    }
    return ok("The Vault is readable without a privacy prompt.");
  },
};
