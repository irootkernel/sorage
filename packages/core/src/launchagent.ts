import { join } from "node:path";
import { type AppError, appError, err, ok, type Result } from "./errors";

/**
 * The per-user macOS LaunchAgent (RUN-007, RUN-011, INIT-009): the canonical label
 * `xyz.rootkernel.sorage`, the plist every value of which is XML-escaped including
 * paths containing `&`, `<`, `>`, or quotation marks, and the `bootstrap`/`bootout`
 * pair that installs and removes it. The legacy `load` and `unload` verbs are never
 * used.
 */
export const LAUNCH_AGENT_LABEL = "xyz.rootkernel.sorage";

/** The plist filename inside the per-user `~/Library/LaunchAgents` directory. */
export const LAUNCH_AGENT_PLIST_FILENAME = `${LAUNCH_AGENT_LABEL}.plist`;

/** The launchd domain target the verbs address, `gui/$UID` for a per-user agent. */
export const launchAgentTarget = (uid: number): string => `gui/${uid}/${LAUNCH_AGENT_LABEL}`;

export function launchAgentPlistPath(agentsDirectory: string): string {
  return join(agentsDirectory, LAUNCH_AGENT_PLIST_FILENAME);
}

/** Escapes one text value for a plist string element. */
export function escapePlistValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface LaunchAgentProgram {
  /** The absolute path of the sorage binary launchd runs. */
  binaryPath: string;
  /** Dev-mode script path between the runtime and the CLI arguments, empty in a compiled build. */
  scriptArgs: string[];
}

export interface LaunchAgentPlistInput {
  program: LaunchAgentProgram;
  /** The `SORAGE_HOME` the launchd-started daemon must use. */
  sorageHome: string;
}

/** Renders the plist: Label, ProgramArguments, EnvironmentVariables, and RunAtLoad. */
export function renderLaunchAgentPlist(input: LaunchAgentPlistInput): string {
  const argumentsBody = [input.program.binaryPath, ...input.program.scriptArgs, "daemon", "serve"]
    .map((argument) => `        <string>${escapePlistValue(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapePlistValue(LAUNCH_AGENT_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsBody}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>SORAGE_HOME</key>
        <string>${escapePlistValue(input.sorageHome)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`;
}

export interface LaunchAgentPorts {
  /** Runs `launchctl bootstrap gui/$UID <plist>`; `false` means launchctl is unavailable. */
  bootstrap(plistPath: string, uid: number): Result<{ bootstrapped: boolean }, AppError>;
  /** Runs `launchctl bootout gui/$UID/label`; an agent that is not loaded reports `wasLoaded: false`. */
  bootout(uid: number): Result<{ wasLoaded: boolean }, AppError>;
  /** True when `launchctl print` reports the agent loaded in the `gui/$UID` domain. */
  isLoaded(uid: number): boolean;
  writePlist(path: string, content: string): Result<null, AppError>;
  readPlist(path: string): string | null;
  removePlist(path: string): void;
  ensureDirectory(path: string): void;
}

export interface LaunchAgentInstallInput {
  program: LaunchAgentProgram;
  sorageHome: string;
  /** The directory the plist is written to, normally `~/Library/LaunchAgents`. */
  agentsDirectory: string;
  uid: number;
}

export interface LaunchAgentInstallOutcome {
  plistPath: string;
  /**
   * False only when the identical plist was already loaded: an unchanged agent is
   * left alone, while a changed plist is refreshed through boot-out and bootstrap
   * so the running daemon never strands on the binary the old plist named.
   */
  bootstrapped: boolean;
}

/** Installs the agent: write the plist, then make `gui/$UID` run exactly it. */
export function installLaunchAgent(
  ports: LaunchAgentPorts,
  input: LaunchAgentInstallInput,
): Result<LaunchAgentInstallOutcome, AppError> {
  const plistPath = launchAgentPlistPath(input.agentsDirectory);
  ports.ensureDirectory(input.agentsDirectory);
  const rendered = renderLaunchAgentPlist(input);
  const existing = ports.readPlist(plistPath);
  const unchanged = existing !== null && existing === rendered;
  const written = ports.writePlist(plistPath, rendered);
  if (!written.ok) return written;
  const loaded = ports.isLoaded(input.uid);
  if (loaded && unchanged) {
    return ok({ plistPath, bootstrapped: false });
  }
  if (loaded) {
    // launchd keeps running the program the loaded plist named, so a changed
    // plist only takes effect after the loaded agent is booted out.
    const bootedOut = ports.bootout(input.uid);
    if (!bootedOut.ok) return bootedOut;
  }
  const bootstrapped = ports.bootstrap(plistPath, input.uid);
  if (!bootstrapped.ok) return bootstrapped;
  return ok({ plistPath, bootstrapped: bootstrapped.value.bootstrapped });
}

export interface LaunchAgentUninstallOutcome {
  /** False when the agent was not loaded; bootout of an unloaded agent is not an error. */
  wasLoaded: boolean;
  /** False when no plist file existed. */
  plistRemoved: boolean;
  plistPath: string;
}

/** Removes the agent: boot it out of `gui/$UID`, then delete the plist file. */
export function uninstallLaunchAgent(
  ports: LaunchAgentPorts,
  input: { agentsDirectory: string; uid: number },
): Result<LaunchAgentUninstallOutcome, AppError> {
  const plistPath = launchAgentPlistPath(input.agentsDirectory);
  const wasLoaded = ports.isLoaded(input.uid);
  if (wasLoaded) {
    const bootedOut = ports.bootout(input.uid);
    if (!bootedOut.ok) return bootedOut;
  }
  const plistExisted = ports.readPlist(plistPath) !== null;
  ports.removePlist(plistPath);
  return ok({ wasLoaded, plistRemoved: plistExisted, plistPath });
}
