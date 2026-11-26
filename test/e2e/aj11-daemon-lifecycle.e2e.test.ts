import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, registerCleanup, runCleanups, sorage } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const startEnv = JSON.parse(start.stdout) as { ok: true; data: { started: true }; meta: { requestId: string } };
    expect(startEnv.ok).toBe(true);
    expect(startEnv.meta.requestId).toMatch(UUID_RE);
    expect(existsSync(daemonJsonPath())).toBe(true);
    const record = JSON.parse(readFileSync(daemonJsonPath(), "utf8")) as Record<string, string | number>;
    for (const field of ["pid", "host", "port", "startedAt", "version", "installationId"]) {
      expect(record).toHaveProperty(field);
    }
    expect(record.port).toBe(port);

    const status = sorage(["daemon", "status", "--json"], { home });
    expect(status.status).toBe(0);
    const statusEnv = JSON.parse(status.stdout) as {
      ok: true;
      data: { restartRequired: boolean };
      meta: { requestId: string };
    };
    expect(statusEnv).toMatchObject({ ok: true, data: { restartRequired: false } });
    expect(statusEnv.meta.requestId).toMatch(UUID_RE);
    expect(statusEnv.meta.requestId).not.toBe(startEnv.meta.requestId);

    // Real web --json and human default outputs against the live daemon.
    const webJson = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
    expect(webJson.status, webJson.stderr).toBe(0);
    const webEnv = JSON.parse(webJson.stdout) as {
      ok: true;
      data: { url: string; daemonStarted: boolean; expiresAt: string; note: string };
      meta: { requestId: string };
    };
    expect(webEnv.ok).toBe(true);
    expect(webEnv.data.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#s=`));
    expect(webEnv.data.daemonStarted).toBe(false);
    expect(webEnv.meta.requestId).toMatch(UUID_RE);
    expect(webEnv.meta.requestId).not.toBe(statusEnv.meta.requestId);

    const webHuman = sorage(["web"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
    expect(webHuman.status, webHuman.stderr).toBe(0);
    expect(webHuman.stdout).toMatch(
      new RegExp(
        `^Web control plane: http://127\\.0\\.0\\.1:${port}/#s=[^\\n]+\\nDaemon: already running\\nExpires: [^\\n]+\\nNote: the fragment secret is single-use and expires; run sorage web again for a fresh one\\n$`,
      ),
    );

    // A second start on the same port fails with PORT_IN_USE.
    const second = sorage(["daemon", "start", "--json"], { home });
    expect(second.status).toBe(75);
    expect(second.stdout).toBe("");
    const secondEnv = JSON.parse(second.stderr);
    expect(secondEnv.error.code).toBe("PORT_IN_USE");
    expect(secondEnv.meta.requestId).toMatch(UUID_RE);

    // The stop drains, ends the process, and removes the record.
    const stop = sorage(["daemon", "stop", "--json"], { home });
    expect(stop.status).toBe(0);
    const stopEnv = JSON.parse(stop.stdout) as { ok: true; data: { stopped: true }; meta: { requestId: string } };
    expect(stopEnv).toMatchObject({ ok: true, data: { stopped: true } });
    expect(stopEnv.meta.requestId).toMatch(UUID_RE);
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
    const statusEnv = JSON.parse(status.stdout);
    expect(statusEnv).toMatchObject({ data: { restartRequired: true } });
    const restart = sorage(["daemon", "restart", "--json"], { home });
    expect(restart.status, restart.stderr).toBe(0);
    // Restart emits exactly one valid JSON envelope on stdout with a distinct UUID.
    const restartEnv = JSON.parse(restart.stdout) as {
      ok: true;
      data: { started: true; daemon: { pid: number } };
      meta: { requestId: string };
    };
    expect(restartEnv).toMatchObject({ ok: true, data: { started: true } });
    expect(restartEnv.meta.requestId).toMatch(UUID_RE);
    expect(restartEnv.meta.requestId).not.toBe(statusEnv.meta.requestId);
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

  it("emits exactly one valid JSON envelope for init --start-daemon --json and uninstall --json with a running daemon (TASK-174)", async () => {
    const isolatedHome = makeTempDir("sorage-aj11-setup-iso-");
    const fakeUserHome = makeTempDir("sorage-aj11-user-home-");
    const binDir = join(fakeUserHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeLaunchctl = join(binDir, "launchctl");
    writeFileSync(
      fakeLaunchctl,
      '#!/bin/sh\nif [ "$1" = "bootout" ]; then echo "No such process" >&2; exit 3; fi\nexit 1\n',
      "utf8",
    );
    chmodSync(fakeLaunchctl, 0o755);
    const port = await freePort();
    registerCleanup(() => {
      sorage(["daemon", "stop"], { home: isolatedHome });
    });

    const init = sorage(
      [
        "init",
        "--vault",
        join(isolatedHome, "vault"),
        "--port",
        String(port),
        "--start-daemon",
        "--non-interactive",
        "--json",
      ],
      { home: isolatedHome },
    );
    expect(init.status, init.stderr).toBe(0);
    const initEnv = JSON.parse(init.stdout) as {
      ok: true;
      data: { daemon: { started: boolean } };
      meta: { requestId: string };
    };
    expect(initEnv).toMatchObject({ ok: true, data: { daemon: { started: true } } });
    expect(initEnv.meta.requestId).toMatch(UUID_RE);

    const uninstall = sorage(["uninstall", "--as-user", "--confirm", "--json"], {
      home: isolatedHome,
      env: {
        HOME: fakeUserHome,
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    expect(uninstall.status, uninstall.stderr).toBe(0);
    const uninstallEnv = JSON.parse(uninstall.stdout) as {
      ok: true;
      data: { daemonStopped: boolean; retainedVaultPath: string };
      meta: { requestId: string };
    };
    expect(uninstallEnv).toMatchObject({
      ok: true,
      data: { daemonStopped: true, retainedVaultPath: join(isolatedHome, "vault") },
    });
    expect(uninstallEnv.meta.requestId).toMatch(UUID_RE);
    expect(uninstallEnv.meta.requestId).not.toBe(initEnv.meta.requestId);

    // When init --start-daemon fails (PORT_IN_USE), parent emits one error in its own format and empty stdout.
    const conflictHomeJson = makeTempDir("sorage-aj11-init-conflict-json-");
    const conflictHomeHuman = makeTempDir("sorage-aj11-init-conflict-human-");
    const blocker = createNetServer();
    const blockedPort = await new Promise<number>((resolve, reject) => {
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as AddressInfo).port));
      blocker.on("error", reject);
    });
    try {
      const conflictJson = sorage(
        [
          "init",
          "--vault",
          join(conflictHomeJson, "vault"),
          "--port",
          String(blockedPort),
          "--start-daemon",
          "--non-interactive",
          "--json",
        ],
        { home: conflictHomeJson },
      );
      expect(conflictJson.status).toBe(75);
      expect(conflictJson.stdout).toBe("");
      const conflictEnv = JSON.parse(conflictJson.stderr);
      expect(conflictEnv).toMatchObject({
        ok: false,
        error: {
          code: "PORT_IN_USE",
          details: {},
          recovery: { suggestedCommand: "Stop the other listener, or change server.port and restart" },
        },
      });
      expect(conflictEnv.meta.requestId).toMatch(UUID_RE);

      const conflictHuman = sorage(
        [
          "init",
          "--vault",
          join(conflictHomeHuman, "vault"),
          "--port",
          String(blockedPort),
          "--start-daemon",
          "--non-interactive",
        ],
        { home: conflictHomeHuman },
      );
      expect(conflictHuman.status).toBe(75);
      expect(conflictHuman.stdout).toBe("");
      expect(conflictHuman.stderr).toBe(
        "PORT_IN_USE: the configured port is already bound\n" +
          "Recovery: Stop the other listener, or change server.port and restart\n",
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
