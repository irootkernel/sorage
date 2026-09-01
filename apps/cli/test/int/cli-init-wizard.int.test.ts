import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type CommandInput, runCli } from "../../src/main";
import { runInitWizard } from "../../src/init-wizard";

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
  };
}

/** A scripted answer sheet: every question consumes one line, exhaustion is end of input. */
function answers(lines: string[]): { input: CommandInput; asked: string[] } {
  const queue = [...lines];
  const asked: string[] = [];
  return {
    input: {
      ask: (question: string) => {
        asked.push(question);
        return queue.length > 0 ? (queue.shift() as string) : null;
      },
    },
    asked,
  };
}

describe("the interactive init wizard", () => {
  it("asks the ten questions in order, summarizes, and creates only after confirmation", () => {
    const home = tempHome("sorage-wizard-create-");
    const io = capture();
    // Questions 8 and 9 print their disabled wording without prompting, so a
    // backup-less run consumes exactly nine answers including the confirmation.
    const script = answers([
      "", // 1. vault path: default
      "y", // 2. create it
      "", // 3. port: default
      "n", // 4. LaunchAgent
      "n", // 5. start daemon
      "n", // 6. vault git
      "n", // 7. daily backup
      "n", // 10. first project
      "y", // final confirmation
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(0);
    const asked = script.asked.map((question) => question.trim()).join("\n");
    expect(asked).toContain("1. Vault directory");
    expect(asked).toContain("2.");
    expect(asked).toContain("3. Daemon server port");
    expect(asked).toContain("4. Install the xyz.rootkernel.sorage LaunchAgent");
    expect(asked).toContain("5. Start the daemon");
    expect(asked).toContain("6. Initialize the Vault as a Git repository");
    expect(asked).toContain("7. Enable daily Git backup");
    expect(asked).toContain("10. Register a first Project");
    expect(asked).toContain("Proceed?");
    expect(io.out.join("")).toContain("Summary:");
    expect(existsSync(join(home, "config.yaml"))).toBe(true);
    expect(existsSync(join(home, "vault", ".sorage-vault.json"))).toBe(true);
    expect(existsSync(join(home, "vault", ".git"))).toBe(false);
  });

  it("mutates nothing when the final confirmation is declined", () => {
    const home = tempHome("sorage-wizard-decline-");
    const io = capture();
    const script = answers([
      "", // vault default
      "y", // create
      "", // port
      "n", // service
      "n", // daemon
      "n", // git
      "n", // backup
      "n", // project
      "n", // final confirmation declined
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Nothing was changed.");
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
    expect(existsSync(join(home, "vault"))).toBe(false);
  });

  it("leaves no trace when input ends before the wizard finishes", () => {
    const home = tempHome("sorage-wizard-eof-");
    const io = capture();
    const script = answers([""]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--non-interactive");
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
  });

  it("enables daily backup with the chosen time and zone, initializing Git with it", () => {
    const home = tempHome("sorage-wizard-backup-");
    const io = capture();
    const script = answers([
      "", // vault default
      "y", // create
      "46400", // port
      "n", // service
      "n", // daemon
      "n", // git (implied by backup)
      "y", // daily backup
      "04:30", // time
      "Asia/Seoul", // timezone
      "n", // push
      "n", // project
      "y", // confirm
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Daily backup requires a Git repository");
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    expect(config).toContain("enabled: true");
    expect(config).toContain("at: 04:30");
    expect(config).toContain("timezone: Asia/Seoul");
    expect(config).toContain("port: 46400");
    expect(existsSync(join(home, "vault", ".git"))).toBe(true);
  });

  it("registers the first Project from question 10", () => {
    const _home = tempHome("sorage-wizard-project-");
    const projectDir = mkdtempSync(join(tmpdir(), "sorage-wizard-project-dir-"));
    const io = capture();
    const script = answers([
      "", // 1. vault default
      "y", // 2. create
      "", // 3. port
      "n", // 4. service
      "n", // 5. daemon
      "n", // 6. git
      "n", // 7. daily backup
      "y", // 10. register a first Project
      "Web App", //    name
      projectDir, //    directory
      "y", // final confirmation
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Added Project web-app");
    const show = capture();
    expect(runCli(["project", "show", "web-app"], show.ports)).toBe(0);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("refuses an option that needs --non-interactive instead of silently ignoring it", () => {
    tempHome("sorage-wizard-flag-");
    const io = capture();
    const code = runCli(["init", "--install-service"], io.ports, { ask: () => null });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--install-service needs --non-interactive");
  });

  it("keeps --json out of wizard mode and the wizard off stdout", () => {
    tempHome("sorage-wizard-json-");
    const io = capture();
    const code = runCli(["init", "--json"], io.ports, { ask: () => null });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--json needs --non-interactive");
  });

  it("re-asks an invalid yes/no answer instead of declining or coercing", () => {
    tempHome("sorage-wizard-invalid-");
    const io = capture();
    const script = answers([
      "", // 1. vault default
      "y", // 2. create
      "", // 3. port
      "x", // 4. invalid service answer
      "x", //    still invalid
      "n", //    accepted on the third try
      "n", // 5. daemon
      "n", // 6. git
      "n", // 7. backup
      "n", // 10. project
      "y", // confirm
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Initialized Sorage");
    expect(script.asked.filter((question) => question.includes("4. Install")).length).toBe(3);
  });

  it("round-trips a multibyte Project name across the wizard", () => {
    const home = tempHome("sorage-wizard-multibyte-");
    const projectDir = join(home, "프로젝트");
    mkdirSync(projectDir, { recursive: true });
    const io = capture();
    const script = answers([
      "", // 1. vault default
      "y", // 2. create
      "", // 3. port
      "n", // 4. service
      "n", // 5. daemon
      "n", // 6. git
      "n", // 7. backup
      "y", // 10. register
      "소라게 프로젝트", // name
      projectDir, // dir
      "y", // confirm
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("소라게 프로젝트");
    const list = capture();
    expect(runCli(["project", "list", "--json"], list.ports)).toBe(0);
    expect(list.out.join("")).toContain("소라게 프로젝트");
  });

  it("round-trips a multibyte name split across a readSync chunk boundary", () => {
    const home = tempHome("sorage-wizard-boundary-");
    const projectDir = join(home, "디렉터리");
    mkdirSync(projectDir, { recursive: true });
    // Drive the real stdin reader in a child process, with the filler chosen
    // so the first byte of the multibyte name lands exactly on the 4096-byte
    // readSync boundary: the first chunk ends after two of its three bytes.
    const name = "소라게";
    const head = ["", "y", "", "n", "n", "n", "n", "y", ""].join("\n");
    // The sheet is head + filler + name + rest; filler makes the name's first
    // byte sit exactly at offset 4096, the readSync chunk boundary.
    const filler = "x".repeat(4096 - Buffer.byteLength(head));
    const sheet = `${head}${filler}${name}\n${projectDir}\ny\n`;
    expect(Buffer.from(sheet, "utf8").indexOf(Buffer.from(name, "utf8"))).toBe(4096);
    const result = spawnSync("bun", [fileURLToPath(new URL("../../src/main.ts", import.meta.url)), "init"], {
      cwd: projectDir,
      encoding: "utf8",
      input: sheet,
      env: { ...process.env, SORAGE_HOME: home },
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("소라게");
    const list = capture();
    expect(runCli(["project", "list", "--json"], list.ports)).toBe(0);
    expect(list.out.join("")).toContain("소라게");
  });

  it("states the machine's actual state in the summary for a declined Vault directory", () => {
    const home = tempHome("sorage-wizard-summary-");
    const io = capture();
    const script = answers([
      join(home, "nowhere-vault"), // 1. custom path, does not exist
      "n", // 2. decline creation
      "", // 3. port
      "n", // 4. service
      "n", // 5. daemon
      "n", // 6. git
      "n", // 7. backup
      "n", // 10. project
      "y", // confirm: the summary prints before this answer is consumed
    ]);
    const asked: string[] = [];
    const input = {
      ask: (question: string) => {
        asked.push(question);
        return script.input.ask(question);
      },
    };
    const wizard = runInitWizard(
      { out: (t: string) => io.out.push(t), err: (t: string) => io.err.push(t), ask: input.ask },
      {
        defaultVaultPath: join(home, "vault"),
        defaultPort: 46321,
        defaultBackupAt: "03:00",
        defaultBackupTimezone: "UTC",
        systemTimezone: null,
      },
    );
    expect(wizard.status).toBe("confirmed");
    // The confirmation summary is printed before the final answer, and the
    // declined directory is described by its actual state.
    expect(io.out.join("")).toContain("does not exist and will not be created");
    expect(io.out.join("")).not.toContain("existing directory, not created by init");
  });

  it("creates the vault nowhere when creation is declined for a missing directory", () => {
    const home = tempHome("sorage-wizard-nocreate-");
    const io = capture();
    const script = answers([
      join(home, "elsewhere-vault"), // 1. custom path
      "n", // 2. decline creation
      "", // 3. port
      "n", // 4. service
      "n", // 5. daemon
      "n", // 6. git
      "n", // 7. daily backup
      "n", // 10. first project
      "y", // final confirmation
    ]);
    const code = runCli(["init"], io.ports, script.input);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("creation was declined");
    expect(existsSync(join(home, "config.yaml"))).toBe(false);
  });
});

describe("the non-interactive 0.3 init flags", () => {
  it("enables the daily schedule with --enable-daily-backup and its pair flags", () => {
    const home = tempHome("sorage-init-flags-backup-");
    const io = capture();
    const code = runCli(
      ["init", "--non-interactive", "--enable-daily-backup", "--backup-at", "05:15", "--timezone", "UTC"],
      io.ports,
    );
    expect(code).toBe(0);
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    expect(config).toContain("enabled: true");
    expect(config).toContain("at: 05:15");
    expect(config).toContain("timezone: UTC");
  });

  it("rejects --backup-at without --enable-daily-backup as a usage error", () => {
    tempHome("sorage-init-flags-orphan-");
    const io = capture();
    const code = runCli(["init", "--non-interactive", "--backup-at", "05:15"], io.ports);
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--enable-daily-backup");
  });

  it("sets server.port through --port in the creating write", () => {
    const home = tempHome("sorage-init-flags-port-");
    const io = capture();
    const code = runCli(["init", "--non-interactive", "--port", "46555"], io.ports);
    expect(code).toBe(0);
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    expect(config).toContain("port: 46555");
  });

  it("performs the requested steps before the JSON envelope reports them", () => {
    const home = tempHome("sorage-init-flags-json-");
    const io = capture();
    const code = runCli(
      ["init", "--non-interactive", "--json", "--enable-daily-backup", "--backup-at", "02:45"],
      io.ports,
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(io.out.join("")) as { data: { backup?: { enabled: boolean } } };
    // The envelope may only claim what actually happened (verified by the file).
    expect(envelope.data.backup?.enabled).toBe(true);
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    expect(config).toContain("enabled: true");
    expect(config).toContain("at: 02:45");
  });
});
