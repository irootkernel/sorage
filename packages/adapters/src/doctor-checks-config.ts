import { lstatSync, readFileSync, statSync } from "node:fs";
import { type CheckOutcome, CONFIG_ACCESS_REPAIR, CONFIG_PATH_REPAIR, configurationPathState } from "@sorage/core";
import { parseConfigurationFile, probeConfigurationPath } from "./config-codec";
import type { DoctorContext } from "./doctor-context";
import { blocking, ok, warning, withRecovery } from "./doctor-recoveries";
import { evaluateStaleness, isPidAlive, parseLockRecord } from "./lockfile";

export const configDoctorChecks: Record<
  "home.permissions" | "config.schema" | "config.lock",
  (context: DoctorContext) => CheckOutcome
> = {
  "home.permissions"(context) {
    let homeExists = false;
    try {
      homeExists = statSync(context.home.home).isDirectory();
    } catch {
      homeExists = false;
    }
    const configPathState = configurationPathState(
      probeConfigurationPath(
        () => statSync(context.home.configFile),
        () => lstatSync(context.home.configFile),
      ),
    );
    if (!homeExists || configPathState === "absent" || configPathState === "access-failure") {
      return withRecovery(blocking("The home directory or config.yaml is missing."), CONFIG_ACCESS_REPAIR);
    }
    // K15: a live symlink to a regular file is followed; only a directory,
    // dangling symlink, loop, or other non-regular entry is a path fault.
    if (configPathState === "path-fault") {
      return withRecovery(blocking("The configuration path is not a regular config.yaml file."), CONFIG_PATH_REPAIR);
    }
    const configMode = statSync(context.home.configFile).mode & 0o777;
    if (configMode !== 0o600) {
      return withRecovery(
        blocking(`config.yaml is mode ${configMode.toString(8)}, expected owner-only 600.`),
        CONFIG_ACCESS_REPAIR,
      );
    }
    return ok("The home tree exists and config.yaml is owner-only.");
  },

  "config.schema"(context) {
    const state = context.configurationState();
    if (state.kind === "unreadable") {
      return withRecovery(blocking("config.yaml cannot be read."), CONFIG_ACCESS_REPAIR);
    }
    if (state.kind === "unsafe-path") {
      return withRecovery(blocking("The configuration path is not a regular config.yaml file."), CONFIG_PATH_REPAIR);
    }
    if (state.kind === "valid") {
      return ok("config.yaml parses and validates against the schema.");
    }
    if (state.kind === "malformed") {
      return blocking(`config.yaml is invalid: ${state.errorMessage}`);
    }
    const parsed = parseConfigurationFile("");
    if (!parsed.ok) {
      return blocking(`config.yaml is invalid: ${parsed.error.message}`);
    }
    return ok("config.yaml parses and validates against the schema.");
  },

  "config.lock"(context) {
    let body: string;
    try {
      body = readFileSync(context.home.lockFile("config"), "utf8");
    } catch {
      return ok("No config.lock is present.");
    }
    const verdict = evaluateStaleness("config", parseLockRecord(body), new Date(), isPidAlive);
    if (verdict.stale) {
      return warning(`config.lock is stale (${verdict.reason}).`);
    }
    return ok("config.lock is absent or held by a live process inside its window.");
  },
};
