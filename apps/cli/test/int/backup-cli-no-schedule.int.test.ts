import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The negative half of the TASK-056 proof the acceptance gate names: only the
 * daemon runs the schedule, proved by a CLI process that ticks nothing. The
 * positive half lives in apps/daemon/test/int/backup-scheduler.int.test.ts.
 * Here a CLI process stays alive across a due instant — the window an eager
 * catch-up wired into any CLI start path would have to fire in — and
 * `backup_runs` stays empty while `backup status` still computes the schedule
 * the CLI read but never ran (BKP-002, BKP-015).
 */
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
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

function backupRunCount(home: string): number {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM backup_runs").get() as { n: number } | undefined;
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

describe("a CLI process never runs the backup schedule (TASK-056)", () => {
  it("leaves backup_runs empty while a long-lived CLI command crosses a due instant", () => {
    const home = tempHome("sorage-cli-no-schedule-");
    const sink = capture();
    expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], sink.ports)).toBe(0);
    // The default schedule zone is UTC, so a UTC wall time that just passed
    // leaves the run overdue now; catch-up defaults to enabled.
    const now = new Date();
    const dailyAt = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    expect(runCli(["backup", "enable", "--daily-at", dailyAt, "--as-user", "--json"], sink.ports)).toBe(0);
    // `inbox --wait` is the CLI's long-lived command, so the process stays
    // alive across the due instant; it needs a registered Project actor.
    const bound = join(home, "bound");
    mkdirSync(bound, { recursive: true });
    expect(runCli(["project", "add", "--name", "Schedule Probe", "--dir", bound, "--json"], sink.ports)).toBe(0);
    const wait = capture();
    expect(runCli(["inbox", "--wait", "--as", "schedule-probe", "--timeout", "2", "--json"], wait.ports)).toBe(0);
    expect(backupRunCount(home)).toBe(0);
    const status = capture();
    expect(runCli(["backup", "status", "--json"], status.ports)).toBe(0);
    const envelope = JSON.parse(status.outText()) as {
      ok: boolean;
      data: { schedule: { enabled: boolean }; nextDueAt: string | null };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.schedule.enabled).toBe(true);
    expect(envelope.data.nextDueAt).not.toBeNull();
    expect(backupRunCount(home)).toBe(0);
  });
});
