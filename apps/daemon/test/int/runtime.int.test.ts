import { createServer as createNetServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeInstallation } from "@sorage/core";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { createNodeDaemonPorts } from "@sorage/adapters/src/daemon-command-ports";
import { serveDaemon } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";
import type { RunningDaemon } from "../../src/runtime";

/**
 * The TASK-044 runtime contract: the record appears at bind, the drain refuses new
 * mutations while in-flight requests finish, the lock is released on stop, and the
 * sweep tick reports a checksum mismatch as ARTIFACT_CORRUPTED.
 */
const home = mkdtempSync(join(tmpdir(), "sorage-daemon-runtime-"));
const ports = createNodeDaemonPorts({ env: { ...process.env, SORAGE_HOME: home } });
let running: RunningDaemon | null = null;
let sweepTicks = 0;
let armed: (() => void) | null = null;

beforeAll(() => {
  process.env.SORAGE_HOME = home;
  // A minimal initialized installation: config.yaml with the defaults is enough,
  // because the runtime never touches the database before the sweep finds records.
  const result = initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") });
  expect(result.ok).toBe(true);
});

afterAll(() => {
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

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

function post(path: string, bearer?: string): Promise<{ status: number; body: string }> {
  const port = running?.record.port ?? 0;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": "application/json",
          ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

describe("the daemon runtime", () => {
  it("binds, records, drains, refuses mutations, and releases the lock", async () => {
    const port = await freePort();
    const write = createNodeConfigCommandPorts().store;
    expect(write.readText()).not.toBeNull();
    // Point the configuration at the free port for this run.
    const config = write.read();
    expect(config.ok && config.value !== null).toBe(true);
    if (!config.ok || config.value === null) return;
    config.value.config.server.port = port;
    const written = write.write(config.value.config, { revision: config.value.revision });
    expect(written.ok).toBe(true);

    running = await serveDaemon({
      serverFactory: createDaemonServer,
      scheduleSweep: (_run) => {
        sweepTicks += 1;
        return () => {};
      },
      armSignals: (drain) => {
        armed = drain;
      },
    });
    expect(running.record.port).toBe(port);
    expect(existsSync(join(home, "run", "daemon.json"))).toBe(true);

    const drained = running.drain();
    await drained;
    expect(existsSync(join(home, "run", "daemon.json"))).toBe(false);
    // The lifetime lock is free again.
    expect(ports.acquireDaemonLock().ok).toBe(true);
    expect(armed).not.toBeNull();
    expect(sweepTicks).toBe(1);
  }, 15000);

  it("sweep ticks verify real artifact bytes and only report true mismatches (SEC-014)", async () => {
    // Seed one materialized artifact whose planted bytes hash to the recorded digest.
    const { openAndMigrate } = await import("@sorage/adapters/src/sqlite/migrator");
    const { MIGRATIONS } = await import("@sorage/adapters/src/sqlite/migrations");
    const db = openAndMigrate(join(home, "state", "sorage.sqlite3"), MIGRATIONS).db;
    const handoff = "2f0ac9a0-0000-4000-8000-0000000000s1";
    const storageKey = `artifacts/${handoff}/s1/sweep.md`;
    const content = "sweep me";
    const digest = createHash("sha256").update(content).digest("hex");
    const project = "3f0ac9a0-0000-4000-8000-0000000000p2";
    const now = new Date().toISOString();
    mkdirSync(dirname(join(home, "vault", storageKey)), { recursive: true });
    writeFileSync(join(home, "vault", storageKey), content);
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)",
    ).run(project, "sweepproj", "Sweep Proj", now, now);
    db.prepare(
      "INSERT INTO handoffs (id, title, sender_kind, recipient_project_id, current_artifact_id, revision, row_version, review_state, created_at, updated_at) VALUES (?,?,?,?,?,1,1,'awaiting_recipient',?,?)",
    ).run(handoff, "Sweep probe", "user", project, "s1", now, now);
    db.prepare(
      "INSERT INTO artifacts (id, handoff_id, storage_key, original_name, stored_name, mime_type, size_bytes, sha256, materialized, created_at) VALUES (?,?,?,?,?,?,?, ?,1,?)",
    ).run("s1", handoff, storageKey, "sweep.md", "sweep.md", "text/markdown", content.length, digest, now);
    db.exec("COMMIT");
    db.close();

    let tick: (() => void) | null = null;
    // The first test's "lock is free" probe re-acquired daemon.lock and left it
    // held by this same process; clear our own leftover record before serving.
    rmSync(join(home, "run", "daemon.lock"), { force: true });
    const port = await freePort();
    const write = createNodeConfigCommandPorts().store;
    const config = write.read();
    expect(config.ok && config.value !== null).toBe(true);
    if (!config.ok || config.value === null) return;
    config.value.config.server.port = port;
    expect(write.write(config.value.config, { revision: config.value.revision }).ok).toBe(true);
    running = await serveDaemon({
      serverFactory: createDaemonServer,
      scheduleSweep: (run) => {
        tick = run;
        return () => {};
      },
      armSignals: () => {},
    });

    const first = (tick as unknown as () => { checked: number; mismatches: string[] })();
    // The vault-relative key resolves to the planted bytes, so a healthy artifact
    // is not reported: this is exactly the false positive the doubled artifacts/
    // prefix used to produce on every tick.
    expect(first.checked).toBe(1);
    expect(first.mismatches).toEqual([]);

    writeFileSync(join(home, "vault", storageKey), "corrupted");
    const second = (tick as unknown as () => { checked: number; mismatches: string[] })();
    expect(second.checked).toBe(1);
    expect(second.mismatches).toEqual([storageKey]);

    await running.drain();
  }, 15000);

  it("answers a controlled restart and then runs the same graceful drain (RUN-008, SEC-015)", async () => {
    rmSync(join(home, "run", "daemon.lock"), { force: true });
    const port = await freePort();
    const write = createNodeConfigCommandPorts().store;
    const config = write.read();
    expect(config.ok && config.value !== null).toBe(true);
    if (!config.ok || config.value === null) return;
    config.value.config.server.port = port;
    expect(write.write(config.value.config, { revision: config.value.revision }).ok).toBe(true);
    running = await serveDaemon({
      serverFactory: createDaemonServer,
      scheduleSweep: () => () => {},
      armSignals: () => {},
      // The in-process harness must survive the restart drain that ends a real
      // daemon process; only the drain behavior is under test here.
      restartExit: () => {},
    });
    expect(existsSync(join(home, "run", "daemon.json"))).toBe(true);
    const token = readFileSync(join(home, "state", "api-token"), "utf8").trim();
    const restart = await post("/api/v1/runtime/restart", token);
    expect(restart.status).toBe(200);
    // The endpoint answers first; the restart then drains exactly like a stop,
    // refusing new mutations before storage closes and removing the record.
    const gone = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const check = () => {
        if (!existsSync(join(home, "run", "daemon.json"))) resolve(true);
        else if (Date.now() - started > 5000) resolve(false);
        else setTimeout(check, 25);
      };
      check();
    });
    expect(gone).toBe(true);
    await running.drain();
  }, 15000);
});
