import { createServer as createNetServer, type AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, runCleanups, sorage } from "./helpers";

/**
 * AJ-11: daemon discovery, port conflict, and graceful drain, driven against the
 * compiled binary exactly as the journey prescribes (RUN-005, RUN-006, RUN-008,
 * RUN-013, SEC-015).
 */
const home = makeTempDir("sorage-aj11-home-");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function daemonJsonPath(): string {
  return `${home}/run/daemon.json`;
}

afterAll(() => runCleanups());

describe("AJ-11 daemon lifecycle", () => {
  it("starts the daemon, records the bind atomically, and discovers it", async () => {
    const port = await freePort();
    expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
    expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);

    const start = sorage(["daemon", "start", "--json"], { home });
    expect(start.status).toBe(0);
    expect(existsSync(daemonJsonPath())).toBe(true);
    const record = JSON.parse(readFileSync(daemonJsonPath(), "utf8")) as Record<string, string | number>;
    for (const field of ["pid", "host", "port", "startedAt", "version", "installationId"]) {
      expect(record).toHaveProperty(field);
    }
    expect(record.port).toBe(port);

    const status = sorage(["daemon", "status", "--json"], { home });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, data: { restartRequired: false } });

    // A second start on the same port fails with PORT_IN_USE.
    const second = sorage(["daemon", "start", "--json"], { home });
    expect(second.status).toBe(75);
    expect(JSON.parse(second.stderr).error.code).toBe("PORT_IN_USE");

    // The stop drains, ends the process, and removes the record.
    const stop = sorage(["daemon", "stop", "--json"], { home });
    expect(stop.status).toBe(0);
    expect(existsSync(daemonJsonPath())).toBe(false);
  });

  it("recovers a daemon.lock whose pid is dead and restarts after a port change", async () => {
    const port = await freePort();
    expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
    // A stale lock from a process that no longer exists is broken by the next start.
    writeFileSync(
      `${home}/run/daemon.lock`,
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), hostname: "gone" }),
    );
    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);

    // A port change requires the controlled restart: status reports it.
    const next = await freePort();
    expect(sorage(["config", "set", "server.port", String(next), "--as-user", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
    expect(
      sorage(["config", "set", "server.port", String(await freePort()), "--as-user", "--json"], { home }).status,
    ).toBe(0);
    const status = sorage(["daemon", "status", "--json"], { home });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ data: { restartRequired: true } });
    expect(sorage(["daemon", "restart", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);
  });

  it("reports daemon.port as a doctor warning while an unrelated process holds the port", async () => {
    const port = await freePort();
    expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      const doctor = sorage(["doctor", "--json"], { home });
      expect(doctor.status).toBe(0);
      const report = JSON.parse(doctor.stdout) as {
        data: { checks: Array<{ id: string; severity: string; recovery?: { suggestedCommand: string } }> };
      };
      const check = report.data.checks.find((entry) => entry.id === "daemon.port");
      expect(check?.severity).toBe("warning");
      expect(check?.recovery?.suggestedCommand).toContain("server.port");
    } finally {
      blocker.close();
    }
  });
});
