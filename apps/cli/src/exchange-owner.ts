import { type ChildProcess, spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { contentionKindOf } from "@sorage/adapters/src/exchange-command-ports";
import { EXCHANGE_RENEW_SECONDS, isCanonicalUuid } from "@sorage/core";
import type { ExchangeLifecycleInput } from "@sorage/core";
import { selfInvocationArgv } from "./self-invocation";

export interface ExchangePair {
  exchangeId: string;
  projectId: string;
}

export interface OwnedExchangeLease extends ExchangePair {
  claimId: string;
  expiresAt: string;
  cwd: string;
}

const CHILD_GRACE_MS = 1_500;
const MAINTENANCE_TIMEOUT_MS = 8_000;
// Renewal may wait up to five seconds each for migration admission and the lease transaction.
const RENEW_CHILD_TIMEOUT_MS = 12_000;
const RENEW_INTERVAL_MS = EXCHANGE_RENEW_SECONDS * 1_000;
const RENEW_RETRY_MS = 1_000;
export const EXCHANGE_JOIN_TIMEOUT_MS = 15_000;
const OWNER_PARENT = "SORAGE_EXCHANGE_OWNER_PARENT";

export function exchangePairOf(value: unknown): ExchangePair | undefined {
  if (typeof value !== "object" || value === null) return;
  const row = value as Record<string, unknown>;
  if (isCanonicalUuid(row.exchangeId) && isCanonicalUuid(row.projectId)) {
    return { exchangeId: row.exchangeId, projectId: row.projectId };
  }
}

export function ownedLeaseOf(data: unknown, cwd: string): OwnedExchangeLease | undefined {
  const pair = exchangePairOf(data);
  if (!pair) return;
  const row = data as Record<string, unknown>;
  if (
    row.state === "active" &&
    isCanonicalUuid(row.claimId) &&
    typeof row.expiresAt === "string" &&
    Number.isFinite(Date.parse(row.expiresAt))
  ) {
    return { ...pair, claimId: row.claimId, expiresAt: row.expiresAt, cwd };
  }
}

export function guardedLeaseOwner(): (() => boolean) | undefined {
  const expected = process.env[OWNER_PARENT];
  if (expected === undefined) return;
  return () => String(process.ppid) === expected;
}

/** A cancelled or expired child remains owned until it exits. */
export function interruptExchangeChild(child: Pick<ChildProcess, "kill">): ReturnType<typeof setTimeout> {
  const signal = (name: NodeJS.Signals) => {
    try {
      child.kill(name);
    } catch {
      // The owned process is already gone.
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), CHILD_GRACE_MS);
  timer.unref();
  return timer;
}

type MaintenanceResult = { kind: "confirmed"; expiresAt: string } | { kind: "fenced" | "retryable" | "failed" };
type KeeperStop = "fenced" | "expired" | "failed";

interface Maintenance {
  result: Promise<MaintenanceResult>;
  stop(): void;
}

export type MaintainExchangeLease = (operation: "renew" | "release", lease: OwnedExchangeLease) => Maintenance;

interface OwnedCliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export function parseMaintenance(
  stdout: string,
  stderr: string,
  status: number | null,
  lease: OwnedExchangeLease,
): MaintenanceResult {
  try {
    const envelope = JSON.parse(status === 0 ? stdout : stderr);
    if (status === 75 && envelope.ok === false) {
      const refusal = envelope.error;
      const code = refusal?.code;
      if (code === "EXCHANGE_CLAIM_CONFLICT") return { kind: "fenced" };
      if (
        code === "SERVICE_PAUSED" ||
        (code === "STORAGE_INSPECTION_UNAVAILABLE" &&
          refusal.details?.storageContention === true &&
          contentionKindOf({ details: refusal.details }) === "lock")
      ) {
        return { kind: "retryable" };
      }
    }
    if (
      status === 0 &&
      envelope.ok === true &&
      envelope.data?.exchangeId === lease.exchangeId &&
      envelope.data.projectId === lease.projectId &&
      envelope.data.claimId === lease.claimId &&
      typeof envelope.data.expiresAt === "string" &&
      Number.isFinite(Date.parse(envelope.data.expiresAt))
    ) {
      return { kind: "confirmed", expiresAt: envelope.data.expiresAt };
    }
  } catch {
    // A crash, transport failure or unrecognized envelope is inconclusive.
  }
  return { kind: "failed" };
}

function launchOwnedCli(argv: string[], cwd: string, timeoutMs = MAINTENANCE_TIMEOUT_MS) {
  const child = spawn(process.execPath, selfInvocationArgv(argv), {
    cwd,
    env: { ...process.env, [OWNER_PARENT]: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let kill: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    kill ??= interruptExchangeChild(child);
  };
  const deadline = setTimeout(stop, timeoutMs);
  const result = new Promise<OwnedCliResult>((settle) => {
    child.on("error", () => {
      // The close event still owns settlement and resource cleanup.
    });
    child.once("close", (status) => {
      clearTimeout(deadline);
      clearTimeout(kill);
      settle({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), status });
    });
  });
  return { result, stop };
}

const launchMaintenance: MaintainExchangeLease = (operation, lease) => {
  const child = launchOwnedCli(
    ["exchange", operation, "--project", lease.projectId, "--claim", lease.claimId, "--json", "--", lease.exchangeId],
    lease.cwd,
    operation === "renew" ? RENEW_CHILD_TIMEOUT_MS : MAINTENANCE_TIMEOUT_MS,
  );
  return {
    result: child.result.then(({ stdout, stderr, status }) => parseMaintenance(stdout, stderr, status, lease)),
    stop: child.stop,
  };
};

/** Join in a bounded one-shot child so the session owner itself holds no SQLite resources. */
export async function joinOwnedExchange(args: {
  exchangeId: string;
  replaceClaim?: string | undefined;
  confirmed: boolean;
  project?: string | undefined;
  asProject?: string | undefined;
  asUser?: boolean | undefined;
  resume?: Extract<ExchangeLifecycleInput, { kind: "join" }>["resume"];
}): Promise<OwnedCliResult> {
  const argv = ["exchange", "join", "--json"];
  if (args.project !== undefined) argv.push("--project", args.project);
  if (args.asProject !== undefined) argv.push("--as", args.asProject);
  if (args.asUser) argv.push("--as-user");
  if (args.replaceClaim !== undefined) argv.push("--replace-claim", args.replaceClaim);
  if (args.confirmed) argv.push("--confirm");
  if (args.resume) {
    argv.push("--pause-version", String(args.resume.pauseVersion), "--operation-id", args.resume.operationId);
    if (args.resume.decision !== undefined) argv.push("--decision", args.resume.decision);
    if (args.resume.replayOnly) argv.push("--replay-only");
  }
  return launchOwnedCli([...argv, "--", args.exchangeId], process.cwd()).result;
}

interface KeeperEntry {
  lease: OwnedExchangeLease;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns schedules and exact results, without Project, claim or storage authority of its own. */
export class ExchangeKeeper {
  private readonly entries = new Map<string, KeeperEntry>();
  private readonly running = new Map<string, Maintenance>();
  private closing = false;
  private quiescing = false;

  constructor(
    private readonly maintain: MaintainExchangeLease = launchMaintenance,
    private readonly onStopped?: (reason: KeeperStop) => void,
  ) {}

  install(lease: OwnedExchangeLease): void {
    if (this.closing) return;
    const key = JSON.stringify([lease.exchangeId, lease.projectId]);
    clearTimeout(this.entries.get(key)?.timer);
    const entry = { lease, deadline: performance.now() + RENEW_INTERVAL_MS };
    this.entries.set(key, entry);
    if (!this.quiescing) this.schedule(key, entry);
  }

  quiesce(): void {
    this.quiescing = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }

  async shutdown(): Promise<boolean> {
    if (this.closing) return true;
    this.closing = true;
    this.quiesce();
    const running = [...this.running.values()];
    // Let each renewal close its database connection before releasing. Its child deadline still applies.
    await Promise.allSettled(running.map((child) => child.result));
    const leases = [...this.entries.values()].map(({ lease }) => lease);
    this.entries.clear();
    const released = await Promise.allSettled(leases.map((lease) => this.release(lease)));
    return released.every((result) => result.status === "fulfilled" && result.value);
  }

  private async release(lease: OwnedExchangeLease): Promise<boolean> {
    const deadline = performance.now() + MAINTENANCE_TIMEOUT_MS;
    for (;;) {
      const child = this.maintain("release", lease);
      const stop = setTimeout(() => child.stop(), Math.max(0, deadline - performance.now()));
      const result = await child.result.finally(() => clearTimeout(stop));
      if (result.kind === "confirmed" || result.kind === "fenced") return true;
      // This typed refusal proves no release committed. Preserve the exact claim in a bounded retry.
      if (result.kind !== "retryable" || performance.now() + 100 >= deadline) return false;
      await sleep(100);
    }
  }

  private schedule(key: string, entry: KeeperEntry): void {
    const untilExpiry = Date.parse(entry.lease.expiresAt) - Date.now();
    const untilAttempt = entry.deadline - performance.now();
    entry.timer = setTimeout(() => void this.renew(key, entry), Math.max(0, Math.min(untilExpiry, untilAttempt)));
  }

  private async renew(key: string, entry: KeeperEntry): Promise<void> {
    if (this.entries.get(key) !== entry || this.quiescing) return;
    if (Date.parse(entry.lease.expiresAt) <= Date.now()) {
      this.entries.delete(key);
      this.onStopped?.("expired");
      return;
    }
    if (this.running.has(key)) {
      entry.deadline = performance.now() + RENEW_RETRY_MS;
      this.schedule(key, entry);
      return;
    }
    let result: MaintenanceResult = { kind: "failed" };
    try {
      const child = this.maintain("renew", entry.lease);
      this.running.set(key, child);
      try {
        result = await child.result;
      } finally {
        this.running.delete(key);
      }
    } catch {
      // Failure stops only the matching entry.
    }
    if (this.entries.get(key) !== entry || this.quiescing) return;
    if (result.kind === "fenced") {
      this.entries.delete(key);
      this.onStopped?.("fenced");
      return;
    }
    if (result.kind === "failed") {
      // Keep exact custody for an eventual graceful release. An unknown result grants no further renewal.
      this.onStopped?.("failed");
      return;
    }
    const now = performance.now();
    if (result.kind === "confirmed") {
      entry.lease.expiresAt = result.expiresAt;
      entry.deadline = Math.max(entry.deadline + RENEW_INTERVAL_MS, now);
    } else {
      entry.deadline = now + RENEW_RETRY_MS;
    }
    this.schedule(key, entry);
  }
}

function writeKeeperDiagnostic(message: string): void {
  try {
    // A closed diagnostic pipe must not emit an unhandled stream error in the owner.
    writeSync(process.stderr.fd, message);
  } catch {
    // The diagnostic is advisory. The owner still settles the exact claim.
  }
}

export function reportExchangeKeeperStop(reason: KeeperStop): void {
  const message =
    reason === "fenced"
      ? "the exact claim was refused"
      : reason === "expired"
        ? "the last confirmed lease expired"
        : "renewal could not be confirmed";
  writeKeeperDiagnostic(
    `The Exchange keeper stopped renewing because ${message}. Inspect the claim before joining again.\n`,
  );
}

export function ownExchangeSession(lease: OwnedExchangeLease, stdinLifetime: boolean): void {
  let stopping = false;
  const cleanup = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    if (stdinLifetime) {
      process.stdin.off("end", shutdown);
      process.stdin.pause();
    }
  };
  const keeper = new ExchangeKeeper(undefined, (reason) => {
    reportExchangeKeeperStop(reason);
    process.exitCode = 1;
    if (reason === "failed") shutdown();
    else cleanup();
  });
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    if (stdinLifetime) process.stdin.pause();
    void keeper
      .shutdown()
      .then((released) => {
        if (!released) {
          writeKeeperDiagnostic("The Exchange session ended before its claim release could be confirmed.\n");
          process.exitCode = 1;
        }
      })
      .finally(cleanup);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (stdinLifetime) {
    process.stdin.once("end", shutdown);
    process.stdin.resume();
  }
  keeper.install(lease);
}
