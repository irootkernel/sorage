import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonRunRecord } from "@sorage/adapters/src/daemon-command-ports";
import { appError, defaultConfiguration, err, ok } from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import type { DaemonRuntimePorts } from "../../src/daemon-commands";
import type { WebRuntimePorts } from "../../src/web";

/**
 * The TASK-174 (ADR-0041) contract goldens for `sorage web` and `sorage daemon
 * start|stop|restart|status` across both `--json` and default human outputs,
 * pinned byte-for-byte with a deterministic request ID plus real subprocess
 * checks verifying distinct per-invocation UUIDs when `SORAGE_TEST_REQUEST_ID`
 * is unset. Refresh the golden by running once with `SORAGE_UPDATE_GOLDENS=1`
 * and reviewing the diff.
 */
const DETERMINISTIC_REQUEST_ID = "2f0ac9a0-0000-4000-8000-0000000000aa";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isolatedHome = mkdtempSync(join(tmpdir(), "sorage-web-daemon-golden-"));
const previousHome = process.env.SORAGE_HOME;
const previousReqId = process.env.SORAGE_TEST_REQUEST_ID;
process.env.SORAGE_HOME = isolatedHome;
process.env.SORAGE_TEST_REQUEST_ID = DETERMINISTIC_REQUEST_ID;

const { runWebCommand } = await import("../../src/web");
const { daemonRestart, daemonStart, daemonStatus, daemonStop } = await import("../../src/daemon-commands");

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const goldenPath = fileURLToPath(new URL("./golden/web-daemon-envelopes.json", import.meta.url));
const updateGoldens = process.env.SORAGE_UPDATE_GOLDENS === "1";

afterAll(() => {
  if (previousHome === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = previousHome;
  if (previousReqId === undefined) delete process.env.SORAGE_TEST_REQUEST_ID;
  else process.env.SORAGE_TEST_REQUEST_ID = previousReqId;
  if (!updateGoldens) rmSync(isolatedHome, { recursive: true, force: true });
});

const INSTALLATION = "1f0ac9a0-0000-4000-8000-0000000000cc";
const SECRET = "S".repeat(48);
const EXPIRES_AT = "2026-11-26T12:05:00.000Z";
const RECORD: DaemonRunRecord = {
  pid: 4242,
  host: "127.0.0.1",
  port: 46321,
  startedAt: "2026-11-26T12:00:00.000Z",
  version: "0.1.5",
  installationId: INSTALLATION,
};

function webPorts(overrides: Partial<WebRuntimePorts> = {}): WebRuntimePorts {
  return {
    probeDaemon: () => true,
    spawnDaemon: () => {},
    openBrowser: () => {},
    readConfig: () => ok(defaultConfiguration(INSTALLATION)),
    issueSecret: () => ok({ secret: SECRET, expiresAt: EXPIRES_AT }),
    ...overrides,
  };
}

function daemonPorts(
  overrides: Partial<DaemonRuntimePorts> & { dieOnSignal?: boolean; initialAlive?: boolean } = {},
): DaemonRuntimePorts {
  let alive = overrides.initialAlive ?? true;
  return {
    readConfiguration: () => ok({ config: defaultConfiguration(INSTALLATION), installationId: INSTALLATION }),
    readDaemonRecord: () => RECORD,
    removeDaemonRecord: () => {},
    isPidAlive: () => alive,
    portHeld: () => false,
    healthConfirms: () => true,
    historyAdmissionRefusal: () => null,
    spawnDaemon: () => {},
    signal: () => {
      if (overrides.dieOnSignal) alive = false;
      return true;
    },
    ...overrides,
  };
}

function captureRun(fn: (ports: { out: (t: string) => void; err: (t: string) => void }) => number) {
  const out: string[] = [];
  const errLines: string[] = [];
  const exitCode = fn({ out: (t) => out.push(t), err: (t) => errLines.push(t) });
  return { exitCode, stdout: out.join(""), stderr: errLines.join("") };
}

function buildSnapshots(): Record<string, { exitCode: number; stdout: string; stderr: string }> {
  let startProbes = 0;
  return {
    webSuccessAlreadyRunningJson: captureRun((p) => runWebCommand(webPorts(), p, { openBrowser: false, json: true })),
    webSuccessAlreadyRunningHuman: captureRun((p) => runWebCommand(webPorts(), p, { openBrowser: false, json: false })),
    webSuccessStartedDaemonJson: captureRun((p) =>
      runWebCommand(
        webPorts({
          probeDaemon: () => {
            startProbes += 1;
            return startProbes > 1;
          },
        }),
        p,
        { openBrowser: false, json: true },
      ),
    ),
    webSuccessStartedDaemonHuman: captureRun((p) => {
      let n = 0;
      return runWebCommand(
        webPorts({
          probeDaemon: () => {
            n += 1;
            return n > 1;
          },
        }),
        p,
        { openBrowser: false, json: false },
      );
    }),
    webFailureDaemonUnavailableJson: captureRun((p) =>
      runWebCommand(webPorts({ probeDaemon: () => false }), p, {
        openBrowser: false,
        json: true,
        startTimeoutMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    webFailureDaemonUnavailableHuman: captureRun((p) =>
      runWebCommand(webPorts({ probeDaemon: () => false }), p, {
        openBrowser: false,
        json: false,
        startTimeoutMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    webFailureConfigInvalidJson: captureRun((p) =>
      runWebCommand(webPorts({ readConfig: () => err(appError("CONFIG_INVALID", "invalid server.port")) }), p, {
        openBrowser: false,
        json: true,
      }),
    ),
    webFailureInternalErrorJson: captureRun((p) =>
      runWebCommand(webPorts({ issueSecret: () => err(appError("INTERNAL_ERROR", "failed to issue web secret")) }), p, {
        openBrowser: false,
        json: true,
      }),
    ),
    daemonStartSuccessJson: captureRun((p) => daemonStart(daemonPorts(), p, { json: true })),
    daemonStartSuccessHumanWithRecord: captureRun((p) => daemonStart(daemonPorts(), p, { json: false })),
    daemonStartSuccessHumanWithoutRecord: captureRun((p) =>
      daemonStart(daemonPorts({ readDaemonRecord: () => null }), p, { json: false }),
    ),
    daemonStartFailureNotInitializedJson: captureRun((p) =>
      daemonStart(daemonPorts({ readConfiguration: () => ok(null) }), p, { json: true }),
    ),
    daemonStartFailureConfigInvalidJson: captureRun((p) =>
      daemonStart(daemonPorts({ readConfiguration: () => err(appError("CONFIG_INVALID", "corrupt config")) }), p, {
        json: true,
      }),
    ),
    daemonStartFailurePortInUseJson: captureRun((p) =>
      daemonStart(daemonPorts({ portHeld: () => true }), p, { json: true }),
    ),
    daemonStartFailureSchemaUnsupportedJson: captureRun((p) =>
      daemonStart(
        daemonPorts({ historyAdmissionRefusal: () => appError("STORAGE_SCHEMA_UNSUPPORTED", "future schema 99") }),
        p,
        { json: true },
      ),
    ),
    daemonStartFailureDaemonUnavailableJson: captureRun((p) =>
      daemonStart(daemonPorts({ healthConfirms: () => false }), p, {
        json: true,
        startTimeoutMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonStopSuccessJson: captureRun((p) =>
      daemonStop(daemonPorts({ dieOnSignal: true }), p, {
        json: true,
        stopGraceMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonStopSuccessHuman: captureRun((p) =>
      daemonStop(daemonPorts({ dieOnSignal: true }), p, {
        json: false,
        stopGraceMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonStopFailureNoRecordJson: captureRun((p) =>
      daemonStop(daemonPorts({ readDaemonRecord: () => null }), p, { json: true }),
    ),
    daemonStopFailureServicePausedJson: captureRun((p) =>
      daemonStop(daemonPorts({ dieOnSignal: false }), p, {
        json: true,
        stopGraceMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonStopFailureServicePausedHuman: captureRun((p) =>
      daemonStop(daemonPorts({ dieOnSignal: false }), p, {
        json: false,
        stopGraceMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonRestartSuccessJson: captureRun((p) =>
      daemonRestart(daemonPorts({ dieOnSignal: true }), p, {
        json: true,
        stopGraceMs: 0,
        startTimeoutMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonRestartSuccessHuman: captureRun((p) =>
      daemonRestart(daemonPorts({ dieOnSignal: true }), p, {
        json: false,
        stopGraceMs: 0,
        startTimeoutMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonRestartFailureStopFailedJson: captureRun((p) =>
      daemonRestart(daemonPorts({ dieOnSignal: false }), p, {
        json: true,
        stopGraceMs: 0,
        now: () => 0,
        sleepMs: () => {},
      }),
    ),
    daemonStatusSuccessUpToDateJson: captureRun((p) => daemonStatus(daemonPorts(), p, { json: true })),
    daemonStatusSuccessUpToDateHuman: captureRun((p) => daemonStatus(daemonPorts(), p, { json: false })),
    daemonStatusSuccessRestartRequiredJson: captureRun((p) =>
      daemonStatus(daemonPorts({ readDaemonRecord: () => ({ ...RECORD, port: RECORD.port + 1 }) }), p, { json: true }),
    ),
    daemonStatusSuccessRestartRequiredHuman: captureRun((p) =>
      daemonStatus(daemonPorts({ readDaemonRecord: () => ({ ...RECORD, port: RECORD.port + 1 }) }), p, { json: false }),
    ),
    daemonStatusFailureNoRecordJson: captureRun((p) =>
      daemonStatus(daemonPorts({ readDaemonRecord: () => null }), p, { json: true }),
    ),
    daemonStatusFailureNoRecordHuman: captureRun((p) =>
      daemonStatus(daemonPorts({ readDaemonRecord: () => null }), p, { json: false }),
    ),
    daemonStatusFailureHealthMismatchJson: captureRun((p) =>
      daemonStatus(daemonPorts({ healthConfirms: () => false }), p, { json: true }),
    ),
  };
}

function runSubprocess(args: string[], home: string, fixedRequestId?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, SORAGE_HOME: home };
  if (fixedRequestId === undefined) delete env.SORAGE_TEST_REQUEST_ID;
  else env.SORAGE_TEST_REQUEST_ID = fixedRequestId;
  return spawnSync("bun", [entry, ...args], { encoding: "utf8", env });
}

describe("web and daemon CLI contract goldens (ADR-0041, TASK-174)", () => {
  it("pins every Web and Daemon JSON and human output against the committed golden snapshot", () => {
    const snapshots = buildSnapshots();
    const serialized = `${JSON.stringify(snapshots, null, 2)}\n`;
    if (updateGoldens) {
      mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });

  it("emits distinct real UUID requestIds across two real CLI invocations when SORAGE_TEST_REQUEST_ID is unset", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "sorage-wd-subproc-"));
    try {
      expect(runSubprocess(["init", "--non-interactive", "--json"], tempHome).status).toBe(0);
      const r1 = runSubprocess(["daemon", "status", "--json"], tempHome);
      const r2 = runSubprocess(["daemon", "status", "--json"], tempHome);
      expect(r1.status).toBe(69);
      expect(r2.status).toBe(69);
      expect(r1.stdout).toBe("");
      expect(r2.stdout).toBe("");
      const id1 = JSON.parse(r1.stderr).meta.requestId as string;
      const id2 = JSON.parse(r2.stderr).meta.requestId as string;
      expect(id1).toMatch(UUID_RE);
      expect(id2).toMatch(UUID_RE);
      expect(id1).not.toBe("daemon");
      expect(id1).not.toBe(id2);

      // Deterministic mode matches the normalized golden error envelope byte-for-byte.
      const fixed = runSubprocess(["daemon", "status", "--json"], tempHome, DETERMINISTIC_REQUEST_ID);
      const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, { stderr: string }>;
      expect(fixed.stderr).toBe(golden.daemonStatusFailureNoRecordJson?.stderr);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
