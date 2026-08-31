import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The read-only-Vault row of the section 4 failure matrix (TASK-061): the whole
 * Vault goes read-only for the operating-system user, mutations fail with a
 * recoverable error and no partial state, reads keep working, and doctor reports
 * `vault.writable` as blocking while the Vault rejects writes.
 */
const homes: string[] = [];
let vaultPath = "";

afterEach(() => {
  if (vaultPath !== "") {
    for (const dir of [vaultPath, join(vaultPath, "artifacts"), join(vaultPath, "staging")]) {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // Best-effort restore before the recursive removal.
      }
    }
  }
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

describe("a whole read-only Vault", () => {
  it("fails mutations recoverably while reads and doctor still work", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-readonly-"));
    homes.push(home);
    process.env.SORAGE_HOME = home;
    vaultPath = join(home, "vault");
    const senderDir = join(home, "sender");
    mkdirSync(senderDir, { recursive: true });
    expect(runCli(["init", "--vault", vaultPath, "--non-interactive"], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Sender", "--dir", senderDir], capture().ports)).toBe(0);

    chmodSync(vaultPath, 0o555);
    chmodSync(join(vaultPath, "artifacts"), 0o555);
    chmodSync(join(vaultPath, "staging"), 0o555);

    // A mutation into the Vault fails with a recoverable error and leaves no
    // partial state: the send never reaches an intent commit.
    const source = join(home, "doc.md");
    writeFileSync(source, "# doc\n");
    const send = capture();
    const sendExit = runCli(
      ["send", "--to", "sender", "--title", "T", "--file", source, "--allow-external-source", "--json"],
      send.ports,
    );
    expect(sendExit).not.toBe(0);
    expect(send.errText()).toContain("staged copy");

    // Reads keep working: configuration and doctor answer, and doctor names the
    // read-only Vault as its blocking finding.
    expect(runCli(["config", "show", "--json"], capture().ports)).toBe(0);
    const doctor = capture();
    expect(runCli(["doctor", "--json"], doctor.ports)).toBe(1);
    const report = JSON.parse(doctor.outText()) as { data: { checks: Array<{ id: string; severity: string }> } };
    expect(report.data.checks.find((check) => check.id === "vault.writable")?.severity).toBe("blocking");
  });
});
