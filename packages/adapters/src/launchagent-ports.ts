import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AppError, LaunchAgentPorts, Result } from "@sorage/core";
import { appError, err, LAUNCH_AGENT_LABEL, launchAgentPlistPath, launchAgentTarget, ok } from "@sorage/core";

/**
 * The production LaunchAgent wiring (RUN-007, RUN-011): the plist lives in
 * `~/Library/LaunchAgents`, every verb is the modern `bootstrap`/`bootout`/`print`
 * family addressed at the `gui/$UID` domain, and the legacy `load`/`unload` verbs
 * are never used. Tests point `userHome` at a temporary directory and put a fake
 * `launchctl` first on `PATH`.
 */
export function launchAgentsDirectory(userHome: string = homedir()): string {
  return `${userHome}/Library/LaunchAgents`;
}

/** The uid of the per-user `gui/$UID` launchd domain, with a fallback off POSIX. */
export function launchAgentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

const LAUNCHCTL_TIMEOUT_MS = 15_000;

export interface NodeLaunchAgentPortsOptions {
  /** Overrides the `launchctl` binary name, so tests can intercept the invocation. */
  launchctlBin?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

function runLaunchctl(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    return spawnSync(bin, args, { timeout: LAUNCHCTL_TIMEOUT_MS, env, encoding: "utf8" });
  } catch {
    return null;
  }
}

export function createNodeLaunchAgentPorts(options: NodeLaunchAgentPortsOptions = {}): LaunchAgentPorts {
  const bin = options.launchctlBin ?? "launchctl";
  const env = options.env ?? process.env;
  const uid = launchAgentUid();

  return {
    bootstrap(plistPath: string): Result<{ bootstrapped: boolean }, AppError> {
      const result = runLaunchctl(bin, ["bootstrap", `gui/${uid}`, plistPath], env);
      if (result === null || result.error !== undefined) {
        return err(appError("DAEMON_UNAVAILABLE", `launchctl could not run for ${plistPath}.`));
      }
      if (result.status === 0) return ok({ bootstrapped: true });
      const detail = (result.stderr ?? "").trim();
      // A label that is already loaded is not a failure of this installation.
      if (detail.includes("Input/output error") || detail.includes("already")) {
        return ok({ bootstrapped: false });
      }
      return err(
        appError(
          "DAEMON_UNAVAILABLE",
          `launchctl bootstrap failed for ${plistPath}${detail === "" ? "" : `: ${detail}`}`,
        ),
      );
    },
    bootout(): Result<{ wasLoaded: boolean }, AppError> {
      const result = runLaunchctl(bin, ["bootout", launchAgentTarget(uid)], env);
      if (result === null || result.error !== undefined) {
        return err(appError("DAEMON_UNAVAILABLE", "launchctl could not run for the LaunchAgent removal."));
      }
      if (result.status === 0) return ok({ wasLoaded: true });
      const detail = (result.stderr ?? "").trim();
      if (detail.includes("No such process") || detail.includes("not loaded")) {
        return ok({ wasLoaded: false });
      }
      return err(appError("DAEMON_UNAVAILABLE", `launchctl bootout failed${detail === "" ? "" : `: ${detail}`}`));
    },
    isLoaded(): boolean {
      const result = runLaunchctl(bin, ["print", launchAgentTarget(uid)], env);
      return result !== null && result.error === undefined && result.status === 0;
    },
    writePlist(path: string, content: string): Result<null, AppError> {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, { encoding: "utf8" });
        chmodSync(path, 0o644);
        return ok(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(appError("DAEMON_UNAVAILABLE", `the LaunchAgent plist could not be written: ${message}`));
      }
    },
    readPlist(path: string): string | null {
      if (!existsSync(path)) return null;
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    removePlist(path: string): void {
      rmSync(path, { force: true });
    },
    ensureDirectory(path: string): void {
      mkdirSync(path, { recursive: true });
    },
  };
}

/** True when the plist names the given binary as the program launchd runs. */
export function plistPointsAtBinary(plistText: string, binaryPath: string): boolean {
  const strings = [...plistText.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? "");
  // XML unescape order: named entities other than &amp; first, &amp; last, so
  // a double-escaped value like &amp;lt; decodes to the literal &lt;.
  const unescaped = strings.map((value) =>
    value
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&"),
  );
  const labelIndex = unescaped.indexOf(LAUNCH_AGENT_LABEL);
  if (labelIndex === -1) return false;
  const programArguments = unescaped.slice(labelIndex + 1);
  return programArguments.includes(binaryPath);
}

export { launchAgentPlistPath };
