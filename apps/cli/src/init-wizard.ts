import { existsSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isValidTimezone, SCHEDULE_AT_PATTERN } from "@sorage/core";

/**
 * The interactive `sorage init` wizard (INIT-004, section 3.2 of the interface
 * contract): ten questions in the documented order, one full summary, and a single
 * final confirmation before anything is mutated. A declined option leaves no trace,
 * and a declined or interrupted confirmation leaves the machine untouched. Input is
 * read one line at a time so the wizard works on a terminal and under a pipe.
 */
export interface PromptPorts {
  /** One line of input without its newline; null when input ends. */
  ask(question: string): string | null;
}

/** The synchronous stdin reader: blocks for the next line, returns null at end of input. */
export function createStdinPrompt(write: (text: string) => void = (text) => process.stdout.write(text)): PromptPorts {
  let pending = Buffer.alloc(0);
  let stdinClosed = false;
  return {
    ask(question: string): string | null {
      write(question);
      while (true) {
        // Scan the raw bytes for the newline so a partial trailing multibyte
        // sequence never passes through a decode/re-encode round-trip: only
        // the complete line is ever decoded.
        const newline = pending.indexOf(0x0a);
        if (newline !== -1) {
          const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
          pending = pending.subarray(newline + 1);
          return line;
        }
        if (stdinClosed) {
          const rest = pending.toString("utf8");
          pending = Buffer.alloc(0);
          return rest === "" ? null : rest.replace(/\r$/, "");
        }
        const chunk = Buffer.alloc(4096);
        let bytesRead: number;
        try {
          bytesRead = readSync(0, chunk, 0, chunk.length, null);
        } catch {
          return null;
        }
        if (bytesRead === 0) {
          stdinClosed = true;
          continue;
        }
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      }
    },
  };
}

export interface WizardPorts extends PromptPorts {
  out: (text: string) => void;
  /** Question prompts render on stderr, so stdout stays the envelope channel. */
  err: (text: string) => void;
}

export interface InitChoices {
  vaultPath: string;
  createVault: boolean;
  serverPort: number;
  installService: boolean;
  startDaemon: boolean;
  initializeGit: boolean;
  enableDailyBackup: boolean;
  backupAt: string;
  backupTimezone: string;
  enablePush: boolean;
  pushRemote: string;
  pushBranch: string;
  registerProject: boolean;
  projectName: string;
  projectDir: string;
}

export type WizardOutcome =
  | { status: "confirmed"; choices: InitChoices }
  | { status: "declined" }
  | { status: "unanswered"; question: string };

export interface WizardDefaults {
  /** The expanded default Vault directory, `~/.sorage/vault` under the active home. */
  defaultVaultPath: string;
  defaultPort: number;
  defaultBackupAt: string;
  defaultBackupTimezone: string;
  /** The timezone the wizard offers when the machine's zone is known. */
  systemTimezone: string | null;
}

function parseBoolean(answer: string, fallback: boolean): boolean | null {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "") return fallback;
  if (["y", "yes"].includes(normalized)) return true;
  if (["n", "no"].includes(normalized)) return false;
  return null;
}

/**
 * Asks one yes/no question, re-asking on an invalid answer (up to three tries)
 * instead of declining or silently coercing; null still means end of input.
 */
function askBoolean(
  ask: (question: string) => string | null,
  question: string,
  fallback: boolean,
  notice: (text: string) => void,
): boolean | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = ask(question);
    if (answer === null) return null;
    const parsed = parseBoolean(answer, fallback);
    if (parsed !== null) return parsed;
    notice("Please answer y or n.\n");
  }
  return null;
}

export function runInitWizard(ports: WizardPorts, defaults: WizardDefaults): WizardOutcome {
  const ask = (question: string): string | null => ports.ask(question);
  const notice = (text: string) => ports.err(text);
  const yesNo = (question: string, fallback: boolean): boolean | null => askBoolean(ask, question, fallback, notice);

  ports.out("Sorage init wizard - ten questions, one summary, one confirmation.\n");
  ports.out("Press Enter to accept each [default]. Nothing changes until the final confirmation.\n\n");

  // 1. Vault path
  const vaultAnswer = ask(`1. Vault directory [${defaults.defaultVaultPath}]: `);
  if (vaultAnswer === null) return { status: "unanswered", question: "vault path" };
  const rawVault = vaultAnswer.trim() === "" ? defaults.defaultVaultPath : vaultAnswer.trim();
  const vaultPath = isAbsolute(rawVault) ? rawVault : resolve(rawVault);

  // 2. Whether to create it (asked only when the directory does not exist)
  let createVault = true;
  if (!existsSync(vaultPath)) {
    const create = yesNo(`2. ${vaultPath} does not exist. Create it? [Y/n]: `, true);
    if (create === null) return { status: "unanswered", question: "create the Vault directory" };
    createVault = create;
  } else {
    ports.out(`2. ${vaultPath} already exists and will be adopted if it holds a valid marker.\n`);
  }

  // 3. Server port
  let serverPort = defaults.defaultPort;
  while (true) {
    const portAnswer = ask(`3. Daemon server port [${defaults.defaultPort}]: `);
    if (portAnswer === null) return { status: "unanswered", question: "server port" };
    const candidate = portAnswer.trim() === "" ? String(defaults.defaultPort) : portAnswer.trim();
    if (/^\d+$/.test(candidate)) {
      const port = Number.parseInt(candidate, 10);
      if (port >= 1024 && port <= 65535) {
        serverPort = port;
        break;
      }
    }
    ports.out("Please answer with a port between 1024 and 65535.\n");
  }

  // 4. LaunchAgent
  const installService = yesNo("4. Install the xyz.rootkernel.sorage LaunchAgent (daemon at login)? [y/N]: ", false);
  if (installService === null) return { status: "unanswered", question: "LaunchAgent installation" };

  // 5. Start the daemon now (the LaunchAgent already starts it when installed)
  let startDaemon = false;
  if (!installService) {
    const start = yesNo("5. Start the daemon now? [y/N]: ", false);
    if (start === null) return { status: "unanswered", question: "start the daemon" };
    startDaemon = start;
  } else {
    ports.out("5. The LaunchAgent starts the daemon immediately and at every login.\n");
  }

  // 6. Vault Git repository
  const gitChoice = yesNo("6. Initialize the Vault as a Git repository? [y/N]: ", false);
  if (gitChoice === null) return { status: "unanswered", question: "Vault Git initialization" };
  let initializeGit = gitChoice;

  // 7. Daily backup
  const enableDailyBackup = yesNo("7. Enable daily Git backup? [y/N]: ", false);
  if (enableDailyBackup === null) return { status: "unanswered", question: "daily backup" };
  if (enableDailyBackup && !initializeGit) {
    ports.out("   Daily backup requires a Git repository, so the Vault will be initialized as one.\n");
    initializeGit = true;
  }

  // 8. Daily time and timezone
  let backupAt = defaults.defaultBackupAt;
  if (enableDailyBackup) {
    while (true) {
      const atAnswer = ask(`8. Daily backup local time [${defaults.defaultBackupAt}]: `);
      if (atAnswer === null) return { status: "unanswered", question: "backup time" };
      const candidate = atAnswer.trim() === "" ? defaults.defaultBackupAt : atAnswer.trim();
      if (SCHEDULE_AT_PATTERN.test(candidate)) {
        backupAt = candidate;
        break;
      }
      ports.out("Please answer with a 24-hour HH:MM local time.\n");
    }
  } else {
    ports.out(`8. Daily backup stays disabled; the schedule keeps its ${defaults.defaultBackupAt} default.\n`);
  }
  let backupTimezone = defaults.defaultBackupTimezone;
  if (enableDailyBackup) {
    const tzDefault = defaults.systemTimezone ?? defaults.defaultBackupTimezone;
    while (true) {
      const tzAnswer = ask(`   Timezone [${tzDefault}]: `);
      if (tzAnswer === null) return { status: "unanswered", question: "backup timezone" };
      const candidate = tzAnswer.trim() === "" ? tzDefault : tzAnswer.trim();
      if (isValidTimezone(candidate)) {
        backupTimezone = candidate;
        break;
      }
      ports.out("Please answer with a known IANA timezone such as Asia/Seoul or UTC.\n");
    }
  }

  // 9. Remote push
  let enablePush = false;
  let pushRemote = "origin";
  let pushBranch = "main";
  if (enableDailyBackup) {
    const pushChoice = yesNo("9. Enable remote push of backups? [y/N]: ", false);
    if (pushChoice === null) return { status: "unanswered", question: "remote push" };
    enablePush = pushChoice;
    if (enablePush) {
      const remoteAnswer = ask("   Remote name [origin]: ");
      if (remoteAnswer === null) return { status: "unanswered", question: "push remote" };
      pushRemote = remoteAnswer.trim() === "" ? "origin" : remoteAnswer.trim();
      const branchAnswer = ask("   Branch [main]: ");
      if (branchAnswer === null) return { status: "unanswered", question: "push branch" };
      pushBranch = branchAnswer.trim() === "" ? "main" : branchAnswer.trim();
    }
  } else {
    ports.out("9. Remote push stays disabled with the daily schedule.\n");
  }

  // 10. First Project
  let registerProject = false;
  let projectName = "";
  let projectDir = "";
  const projectChoice = yesNo("10. Register a first Project? [y/N]: ", false);
  if (projectChoice === null) return { status: "unanswered", question: "first Project" };
  registerProject = projectChoice;
  if (registerProject) {
    const nameAnswer = ask("    Project display name: ");
    if (nameAnswer === null || nameAnswer.trim() === "") return { status: "unanswered", question: "Project name" };
    projectName = nameAnswer.trim();
    const dirAnswer = ask("    Project directory: ");
    if (dirAnswer === null || dirAnswer.trim() === "") return { status: "unanswered", question: "Project directory" };
    projectDir = isAbsolute(dirAnswer.trim()) ? dirAnswer.trim() : resolve(dirAnswer.trim());
  }

  const choices: InitChoices = {
    vaultPath,
    createVault,
    serverPort,
    installService,
    startDaemon,
    initializeGit,
    enableDailyBackup,
    backupAt,
    backupTimezone,
    enablePush,
    pushRemote,
    pushBranch,
    registerProject,
    projectName,
    projectDir,
  };

  ports.out("\nSummary:\n");
  ports.out(
    `  Vault: ${choices.vaultPath}${choices.createVault ? "" : " (existing directory, not created by init)"}\n`,
  );
  ports.out(`  Server port: ${choices.serverPort}\n`);
  ports.out(`  LaunchAgent: ${choices.installService ? "install xyz.rootkernel.sorage" : "not installed"}\n`);
  ports.out(`  Daemon: ${choices.startDaemon || choices.installService ? "starts now" : "not started"}\n`);
  ports.out(`  Vault Git: ${choices.initializeGit ? "initialized" : "not initialized"}\n`);
  ports.out(
    `  Daily backup: ${choices.enableDailyBackup ? `${choices.backupAt} ${choices.backupTimezone}` : "disabled"}\n`,
  );
  ports.out(`  Remote push: ${choices.enablePush ? `${choices.pushRemote} ${choices.pushBranch}` : "disabled"}\n`);
  ports.out(
    `  First Project: ${choices.registerProject ? `${choices.projectName} at ${choices.projectDir}` : "none"}\n`,
  );

  const confirmAnswer = ask("Proceed? [y/N]: ");
  if (confirmAnswer === null) return { status: "unanswered", question: "final confirmation" };
  if (parseBoolean(confirmAnswer, false) === true) return { status: "confirmed", choices };
  return { status: "declined" };
}
