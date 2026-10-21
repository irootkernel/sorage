import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BINARY, makeTempDir, registerCleanup, runCleanups, sorage } from "./helpers";

/**
 * The SHR-015 storage-preparation contention contract on the compiled binary:
 * each covered family refuses with the typed envelope, exit 75, and its
 * per-surface recovery at the startup site (a write lock held before the
 * command starts meets the drain's or the factory's migration) and in the
 * command's own domain transaction (the test-only Git PATH barrier sequences
 * the compiled process past startup before the lock is taken, because the
 * body inputs of every covered mutating command are validated as regular
 * files and no mutating command reads stdin). Every refusal is proven to have
 * committed none of the requested domain changes by a before-and-after
 * snapshot — row values, row versions, events, idempotency receipts, and
 * pending intents — read through the independent lock-holding connection, and
 * the identical request (same mode, input, and idempotency key where the
 * command takes one) succeeds for every family once the lock is released.
 * Genuine usage errors keep exit 2 under the same contention.
 */

const wrapperDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const wrapper = join(wrapperDir, "git");

interface AsyncRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnSorage(
  args: string[],
  home: string,
  cwd: string,
  barrier: { signal: string; release: string } | null,
): { done: Promise<AsyncRun> } {
  const child = spawn(BINARY, args, {
    cwd,
    env: {
      ...process.env,
      SORAGE_HOME: home,
      SORAGE_TEST_REQUEST_ID: undefined,
      ...(barrier === null
        ? {}
        : {
            PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
            SORAGE_GIT_BARRIER_SIGNAL: barrier.signal,
            SORAGE_GIT_BARRIER_RELEASE: barrier.release,
          }),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16384);
  });
  const done = once(child, "close").then(([status]: Array<number | null | undefined>) => ({
    status: status ?? null,
    stdout,
    stderr,
  }));
  return { done };
}

function envelope(stderr: string): {
  ok: boolean;
  error?: { code: string; message: string; details: Record<string, unknown>; recovery?: { suggestedCommand: string } };
} {
  return JSON.parse(stderr);
}

/** A sorted snapshot of every row of the given tables, read through the given connection. */
function snapshot(db: DatabaseSync, tables: string[]): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    result[table] = db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(JSON.stringify(row)));
  }
  return result;
}

beforeAll(() => {
  chmodSync(wrapper, 0o755);
});

afterAll(() => {
  runCleanups();
});

describe("startup-site contention on the compiled binary", () => {
  it("refuses channel create, send, and project add at the drain or migration, proves no change, and retries successfully", () => {
    const home = makeTempDir("sorage-e2e-contention-");
    const work = makeTempDir("sorage-e2e-contention-work-");
    const projectDir = join(work, "b");
    mkdirSync(projectDir);
    expect(sorage(["init", "--vault", join(home, "vault"), "--non-interactive"], { home }).status).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", work, "--json"], { home }).status,
    ).toBe(0);
    const sendKey = "startup-send-key";

    const holder = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const channelTables = ["channels", "channel_participants", "events", "idempotency_keys"];
      const sendTables = ["handoffs", "events", "idempotency_keys", "pending_fs_ops", "content_records", "artifacts"];
      const projectTables = ["projects", "project_bindings", "events"];

      const channelBefore = snapshot(holder, channelTables);
      const channel = sorage(
        ["channel", "create", "--main-handle", "orchestrator", "--idempotency-key", "startup-create-key", "--json"],
        { home, cwd: work },
      );
      expect(channel.status, channel.stderr).toBe(75);
      const channelEnvelope = envelope(channel.stderr);
      expect(channelEnvelope.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
      expect(channelEnvelope.error?.details.storageContention).toBe(true);
      expect(channelEnvelope.error?.message).toContain("Channel storage is contended");
      expect(channelEnvelope.error?.recovery?.suggestedCommand).toContain("a replay-only retry stays replay-only");
      expect(snapshot(holder, channelTables)).toEqual(channelBefore);

      const sendBefore = snapshot(holder, sendTables);
      const send = sorage(
        ["send", "--to", "alpha", "--title", "t", "--body", "b", "--idempotency-key", sendKey, "--json"],
        {
          home,
          cwd: work,
        },
      );
      expect(send.status, send.stderr).toBe(75);
      expect(envelope(send.stderr).error?.message).toContain("Handoff storage is contended");
      expect(envelope(send.stderr).error?.recovery?.suggestedCommand).toContain("sorage send --replay-only first");
      expect(snapshot(holder, sendTables)).toEqual(sendBefore);

      const projectBefore = snapshot(holder, projectTables);
      const project = sorage(["project", "add", "--name", "Beta", "--slug", "beta", "--dir", projectDir, "--json"], {
        home,
        cwd: work,
      });
      expect(project.status, project.stderr).toBe(75);
      expect(envelope(project.stderr).error?.message).toContain("Project storage is contended");
      expect(snapshot(holder, projectTables)).toEqual(projectBefore);

      // A genuine usage error under the same held lock still exits 2 with no envelope.
      const usage = sorage(["channel", "messages", "8f19d8c8-1111-4111-8111-111111111111", "--wait", "--cursor", "c"], {
        home,
        cwd: work,
      });
      expect(usage.status).toBe(2);
      expect(usage.stderr).not.toContain('"ok"');
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed; the assertions are decisive.
      }
      holder.close();
    }

    // Retryability: with the lock released, the identical requests succeed for
    // every family, preserving the original mode, input, and idempotency key.
    const channelRetry = sorage(
      ["channel", "create", "--main-handle", "orchestrator", "--idempotency-key", "startup-create-key", "--json"],
      { home, cwd: work },
    );
    expect(channelRetry.status, channelRetry.stderr).toBe(0);
    const sendRetry = sorage(
      ["send", "--to", "alpha", "--title", "t", "--body", "b", "--idempotency-key", sendKey, "--json"],
      { home, cwd: work },
    );
    expect(sendRetry.status, sendRetry.stderr).toBe(0);
    expect(JSON.parse(sendRetry.stdout).data.handoffs).toHaveLength(1);
    const projectRetry = sorage(["project", "add", "--name", "Beta", "--slug", "beta", "--dir", projectDir, "--json"], {
      home,
      cwd: work,
    });
    expect(projectRetry.status, projectRetry.stderr).toBe(0);
  });
});

describe("domain-transaction contention through the Git PATH barrier (W2)", () => {
  it(
    "refuses channel submit, send, and project add inside their own domain transactions, proves no change, and retries",
    { timeout: 120_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sorage-e2e-barrier-"));
      registerCleanup(() => rmSync(home, { recursive: true, force: true }));
      const repo = mkdtempSync(join(tmpdir(), "sorage-e2e-barrier-repo-"));
      registerCleanup(() => rmSync(repo, { recursive: true, force: true }));
      expect(sorage(["init", "--vault", join(home, "vault"), "--non-interactive"], { home }).status).toBe(0);
      expect(spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" }).status).toBe(0);
      expect(
        sorage(["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", repo, "--json"], { home }).status,
      ).toBe(0);
      // The file-backed send body exceeds the inline threshold so the fan-out is
      // file-backed; it lives inside the sender workspace.
      const bodyFile = join(repo, "large-body.txt");
      writeFileSync(bodyFile, `# report\n${"x".repeat(70_000)}\n`);

      // An existing Channel with its main participant for the submit case.
      const created = sorage(["channel", "create", "--main-handle", "orchestrator", "--json"], { home, cwd: repo });
      expect(created.status, created.stderr).toBe(0);
      const createdEnvelope = JSON.parse(created.stdout) as {
        data: { channel: { id: string; mainParticipantId: string } };
      };
      const channelId = createdEnvelope.data.channel.id;
      const mainId = createdEnvelope.data.channel.mainParticipantId;
      const worker = sorage(
        [
          "channel",
          "participant",
          "add",
          channelId,
          "--as-participant",
          mainId,
          "--role",
          "worker",
          "--handle",
          "worker",
          "--json",
        ],
        { home, cwd: repo },
      );
      expect(worker.status, worker.stderr).toBe(0);
      const workerId = (JSON.parse(worker.stdout) as { data: { participant: { id: string } } }).data.participant.id;

      const runOne = async (args: string[], proofTables: string[], expectText: string): Promise<void> => {
        const signal = join(home, "barrier.signal");
        const release = join(home, "barrier.release");
        rmSync(signal, { force: true });
        rmSync(release, { force: true });
        const spawned = spawnSorage(args, home, repo, { signal, release });
        // Wait for the compiled process to pass startup and reach the Git probe.
        const deadline = Date.now() + 15_000;
        while (!existsSync(signal) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!existsSync(signal)) {
          const early = await Promise.race([
            spawned.done.then((r) => JSON.stringify(r).slice(0, 800)),
            new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 1000)),
          ]);
          throw new Error(`the barrier did not signal; child: ${early}`);
        }
        const holder = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
        try {
          const before = snapshot(holder, proofTables);
          holder.exec("BEGIN IMMEDIATE");
          writeFileSync(release, "released");
          const outcome = await Promise.race([
            spawned.done,
            new Promise<AsyncRun>((_, reject) => setTimeout(() => reject(new Error("command timed out")), 20_000)),
          ]);
          expect(outcome.status, outcome.stderr).toBe(75);
          const refusal = envelope(outcome.stderr);
          expect(refusal.error?.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
          expect(refusal.error?.message).toContain(expectText);
          // The refused command committed none of the requested domain changes:
          // every table it would write is byte-identical, row values, row
          // versions, events, receipts, and intents included.
          expect(snapshot(holder, proofTables)).toEqual(before);
        } finally {
          try {
            holder.exec("ROLLBACK");
          } catch {
            // The transaction may already be closed; the assertions are decisive.
          }
          holder.close();
        }
      };

      const submitArgs = [
        "channel",
        "submit",
        channelId,
        "--as-participant",
        workerId,
        "--kind",
        "report",
        "--body",
        "barrier report body",
        "--idempotency-key",
        "barrier-submit-key",
        "--json",
      ];
      await runOne(
        submitArgs,
        ["channel_messages", "events", "idempotency_keys", "content_records", "pending_fs_ops"],
        "Channel storage is contended",
      );

      const sendArgs = [
        "send",
        "--to",
        "alpha",
        "--title",
        "t",
        "--file",
        bodyFile,
        "--idempotency-key",
        "barrier-send-key",
        "--json",
      ];
      await runOne(
        sendArgs,
        ["handoffs", "events", "idempotency_keys", "pending_fs_ops", "content_records", "artifacts"],
        "Handoff storage is contended",
      );

      const fresh = mkdtempSync(join(tmpdir(), "sorage-e2e-barrier-fresh-"));
      registerCleanup(() => rmSync(fresh, { recursive: true, force: true }));
      await runOne(
        ["project", "add", "--name", "Beta", "--slug", "beta", "--dir", fresh, "--json"],
        ["projects", "project_bindings", "events"],
        "Project storage is contended",
      );

      // Retryability with the lock free: the identical requests succeed for
      // every family, preserving the original mode, input, and idempotency key.
      const submitRetry = sorage(submitArgs, { home, cwd: repo });
      expect(submitRetry.status, submitRetry.stderr).toBe(0);
      expect(JSON.parse(submitRetry.stdout).data.replayed).toBe(false);
      const sendRetry = sorage(sendArgs, { home, cwd: repo });
      expect(sendRetry.status, sendRetry.stderr).toBe(0);
      expect(JSON.parse(sendRetry.stdout).data.handoffs).toHaveLength(1);
      const projectRetry = sorage(["project", "add", "--name", "Beta", "--slug", "beta", "--dir", fresh, "--json"], {
        home,
        cwd: repo,
      });
      expect(projectRetry.status, projectRetry.stderr).toBe(0);
    },
  );
});
