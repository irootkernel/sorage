import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, envelopeOf, errorEnvelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

const binary = process.env.SORAGE_AJ35_BINARY ?? BINARY;

function fixture() {
  const root = makeTempDir("aj35-");
  const home = join(root, "home");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  mkdirSync(alpha);
  mkdirSync(beta);
  function cli(argv: string[], cwd = alpha) {
    const run = sorage([...argv, "--json"], { binary, home, cwd });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    return envelopeOf(run).data as Record<string, unknown>;
  }
  cli(["init", "--non-interactive"]);
  for (const [slug, cwd] of [
    ["alpha", alpha],
    ["beta", beta],
  ] as const) {
    cli(["project", "add", "--name", slug, "--slug", slug, "--dir", cwd]);
  }
  const { exchangeId } = cli([
    "exchange",
    "create",
    "--member",
    "beta",
    "--goal",
    "Verify owner loss",
    "--criterion",
    "Bound stale authority",
    "--operation-id",
    "create",
  ]);
  return { home, alpha, beta, exchangeId: String(exchangeId) };
}

function owner(args: string[], cwd: string, home: string) {
  const child = spawn(binary, args, {
    cwd,
    env: { ...process.env, SORAGE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const pid = child.pid;
  if (!pid) throw new Error("The compiled owner did not start.");
  return { child, closed, pid, stdout: () => stdout, stderr: () => stderr };
}

async function observe<T>(read: () => T | undefined, timeout: number, label: string): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const value = read();
    if (value !== undefined) return value;
    await sleep(35);
  } while (performance.now() < deadline);
  throw new Error(`Timed out observing ${label}.`);
}

function envelope(
  text: string,
):
  | { ok: boolean; data: { claimId: string; projectId: string; expiresAt: string }; error?: { code: string } }
  | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ownChildren(parent: number): number[] {
  return execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const found = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!found || Number(found[2]) !== parent || !found[3]?.includes("exchange renew")) return [];
      return [Number(found[1])];
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stop(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

describe("AJ-35 compiled Exchange owner lifecycle", () => {
  it("gracefully releases the exact CLI claim on declared stdin EOF", async () => {
    const f = fixture();
    const session = owner(["exchange", "session", f.exchangeId, "--stdin-lifetime", "--json"], f.alpha, f.home);
    const claims = () => {
      const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"), { readOnly: true });
      try {
        return db.prepare("SELECT claim_id FROM exchange_claims").all();
      } finally {
        db.close();
      }
    };
    try {
      const joined = await observe(() => envelope(session.stdout()), 5_000, "initial join envelope");
      expect(joined.ok, session.stderr()).toBe(true);
      expect(claims()).toEqual([{ claim_id: joined.data.claimId }]);
      session.child.stdin?.end();
      expect(await session.closed).toEqual({ code: 0, signal: null });
      expect(claims()).toEqual([]);
    } finally {
      stop(session.child);
      await session.closed;
    }
  }, 12_000);

  it.each(["forced owner loss", "temporary storage refusal"] as const)(
    "fences or retries a blocked renewal for both owners through %s",
    async (scenario) => {
      const f = fixture();
      const direct = owner(["exchange", "session", f.exchangeId, "--json"], f.alpha, f.home);
      const mcp = owner(["mcp"], f.beta, f.home);
      let db: DatabaseSync | undefined;
      let pauseLock: string | undefined;
      const holders: number[] = [];
      try {
        const a = await observe(() => envelope(direct.stdout()), 5_000, "CLI join");
        expect(a.ok, direct.stderr()).toBe(true);
        async function joinMcp(id: number) {
          mcp.child.stdin?.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "exchange_join", arguments: { exchangeId: f.exchangeId, cwd: f.beta, project: "beta" } },
            })}\n`,
          );
          return observe(
            () => {
              const responses = mcp
                .stdout()
                .split("\n")
                .slice(0, -1)
                .map((line) => JSON.parse(line));
              return responses.find((response) => response.id === id)?.result?.structuredContent as ReturnType<
                typeof envelope
              >;
            },
            5_000,
            "MCP join",
          );
        }
        let b = await joinMcp(1);
        if (b.error?.code === "STORAGE_INSPECTION_UNAVAILABLE") {
          await sleep(100);
          b = await joinMcp(2);
        }
        expect(b.ok, `${JSON.stringify(b)}\n${mcp.stderr()}`).toBe(true);
        const writer = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
        db = writer;
        const claims = () =>
          writer.prepare("SELECT project_id, claim_id, expires_at FROM exchange_claims ORDER BY project_id").all();
        const before = claims();
        expect(before).toHaveLength(2);
        expect(before).toEqual(
          expect.arrayContaining(
            [a.data, b.data].map((lease) => ({
              project_id: lease.projectId,
              claim_id: lease.claimId,
              expires_at: lease.expiresAt,
            })),
          ),
        );
        writer.exec("BEGIN IMMEDIATE");
        const blocked = await observe(
          () => {
            const first = ownChildren(direct.pid)[0];
            const second = ownChildren(mcp.pid)[0];
            return first && second ? [first, second] : undefined;
          },
          13_000,
          "both renewal children",
        );
        holders.push(...blocked);
        await sleep(200);
        for (const pid of blocked) expect(alive(pid)).toBe(true);
        if (scenario === "temporary storage refusal") {
          await observe(
            () => (blocked.every((pid) => !alive(pid)) ? true : undefined),
            7_000,
            "both first attempts exiting while the writer lock persists",
          );
          expect(claims()).toEqual(before);
          expect(alive(direct.pid) && alive(mcp.pid)).toBe(true);
          const lockPath = join(f.home, "run", "vault-move.lock");
          writeFileSync(
            lockPath,
            JSON.stringify({
              pid: process.pid,
              startedAt: new Date().toISOString(),
              hostname: hostname(),
            }),
            { flag: "wx" },
          );
          pauseLock = lockPath;
          writer.exec("ROLLBACK");
          writer.close();
          db = undefined;
          const paused = sorage(["exchange", "renew", f.exchangeId, "--claim", a.data.claimId, "--json"], {
            binary,
            cwd: f.alpha,
            home: f.home,
          });
          expect(paused.status).toBe(75);
          expect(errorEnvelopeOf(paused).error.code).toBe("SERVICE_PAUSED");
          await sleep(1_300);
          function currentClaims() {
            const read = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"), { readOnly: true });
            try {
              return read
                .prepare("SELECT project_id, claim_id, expires_at FROM exchange_claims ORDER BY project_id")
                .all() as Array<{ project_id: string; claim_id: string; expires_at: string }>;
            } finally {
              read.close();
            }
          }
          expect(currentClaims()).toEqual(before);
          rmSync(pauseLock);
          pauseLock = undefined;
          await observe(
            () => {
              const current = currentClaims();
              expect(current.map(({ claim_id }) => claim_id)).toEqual(before.map((row) => row.claim_id));
              return current.every(({ expires_at }, index) => expires_at > String(before[index]?.expires_at))
                ? current
                : undefined;
            },
            6_000,
            "both exact claims renewing after the lock and pause clear",
          );
          direct.child.kill("SIGTERM");
          mcp.child.stdin?.end();
          expect(await direct.closed).toEqual({ code: 0, signal: null });
          expect(await mcp.closed).toEqual({ code: 0, signal: null });
          expect(currentClaims()).toEqual([]);
          return;
        }
        direct.child.kill("SIGKILL");
        mcp.child.kill("SIGKILL");
        expect(await direct.closed).toEqual({ code: null, signal: "SIGKILL" });
        expect(await mcp.closed).toEqual({ code: null, signal: "SIGKILL" });
        writer.exec("ROLLBACK");
        await observe(
          () => (blocked.every((pid) => !alive(pid)) ? true : undefined),
          7_000,
          "orphaned renewal child exit",
        );
        expect(claims()).toEqual(before);
        for (const cwd of [f.alpha, f.beta]) {
          const conflict = sorage(["exchange", "join", f.exchangeId, "--json"], { binary, cwd, home: f.home });
          expect(conflict.status).toBe(75);
        }
        expect(claims()).toEqual(before);
      } finally {
        if (pauseLock) rmSync(pauseLock, { force: true });
        if (db?.isTransaction) db.exec("ROLLBACK");
        for (const child of [direct.child, mcp.child]) stop(child);
        await Promise.all([direct.closed, mcp.closed]);
        await observe(
          () => (holders.every((pid) => !alive(pid)) ? true : undefined),
          7_000,
          "owned maintenance cleanup",
        );
        db?.close();
      }
    },
    32_000,
  );
});
