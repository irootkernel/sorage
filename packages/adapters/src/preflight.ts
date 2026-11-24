import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppError,
  appError,
  assessPreflight,
  type Configuration,
  err,
  ok,
  type PreflightReport,
  type Result,
} from "@sorage/core";
import { acquireInspection } from "./preflight-capture";
import { classifyAndLoadConfig } from "./preflight-classify";
import {
  fileShape,
  type InstallationInspection,
  pathLook,
  type PreflightInspectPorts,
  rootBinding,
  unavailable,
} from "./preflight-fs";
import { locateHome } from "./preflight-home";

export {
  CAPTURE_ATTEMPTS,
  type InstallationInspection,
  type InstallationInspectionReader,
  type PreflightInspectPorts,
  type PreflightLiveness,
} from "./preflight-fs";

/**
 * Non-mutating installation inspection. The selected SQLite files are copied
 * and opened only as a private copy; assessPreflight owns the verdict.
 */
export function inspectPreflight(homePath: string, ports: PreflightInspectPorts = {}): PreflightReport {
  return withInstallationInspection(homePath, ports, (observation) => assessPreflight(observation.facts));
}

/** Config-only bootstrap; it never replaces the later coherent receipt inspection. */
export function readRecoveryConfiguration(homePath: string, userHome: string): Result<Configuration, AppError> {
  const located = locateHome(homePath);
  if (located.kind === "absent") {
    return locateHome(homePath).kind === "absent"
      ? err(appError("NOT_INITIALIZED", "the selected Installation has no configuration"))
      : err(unavailable());
  }
  if (located.kind !== "directory") return err(unavailable());
  const binding = rootBinding(homePath);
  if (binding === undefined || binding !== rootBinding(located.canonical)) return err(unavailable());
  const path = join(located.canonical, "config.yaml");
  if (pathLook(path).kind === "missing") {
    return pathLook(path).kind === "missing" && rootBinding(homePath) === binding
      ? err(appError("NOT_INITIALIZED", "the selected Installation has no configuration"))
      : err(unavailable());
  }
  const stamp = () => {
    const shape = fileShape(path, located.canonical, true);
    const look = pathLook(path);
    if (shape === undefined || look.kind !== "stat" || look.stat.isSymbolicLink() || !look.stat.isFile())
      return undefined;
    return `${shape} ${look.stat.size} ${look.stat.mtimeMs} ${look.stat.ctimeMs}`;
  };
  const before = stamp();
  if (before === undefined) return err(unavailable());
  let text: string;
  let again: string;
  try {
    text = readFileSync(path, "utf8");
    again = readFileSync(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
      return err(unavailable());
    throw error;
  }
  if (text !== again || stamp() !== before || rootBinding(homePath) !== binding) return err(unavailable());
  const classified = classifyAndLoadConfig(text, userHome, homePath);
  if (classified.fact.kind !== "supported" || classified.config === undefined) {
    return err(
      appError(
        classified.fact.kind === "newer" || classified.fact.kind === "unsupported-format"
          ? "STORAGE_SCHEMA_UNSUPPORTED"
          : "CONFIG_INVALID",
        "the selected configuration cannot support inspection",
      ),
    );
  }
  return ok(classified.config);
}

/** Capture retries end before the consumer runs. Reader and scratch never escape this lifetime. */
export function withInstallationInspection<T>(
  homePath: string,
  ports: PreflightInspectPorts,
  consume: (observation: InstallationInspection) => T,
): T {
  const observation = acquireInspection(homePath, ports);
  try {
    return consume(observation);
  } finally {
    observation.dispose?.();
  }
}
