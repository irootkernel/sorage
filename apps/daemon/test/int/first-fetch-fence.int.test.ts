import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeDaemonDatabase } from "@sorage/adapters/src/daemon-command-ports";
import * as handoffPorts from "@sorage/adapters/src/handoff-command-ports";
import { clearMoveFence, setMoveFenceAndCountPending } from "@sorage/adapters/src/intent-log";
import { createNodeInitPorts } from "@sorage/adapters/src/init-ports";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { type ArtifactReadHandle, fetchHandoff, initializeInstallation, prepareHandoffFetch } from "@sorage/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../src/auth";
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonConfigService } from "../../src/runtime";
import { createDaemonServer } from "../../src/server";

const home = mkdtempSync(join(tmpdir(), "sorage-first-fetch-fence-"));
const oldHome = process.env.SORAGE_HOME;
const lock = join(home, "run", "vault-move.lock");
const bytes = Buffer.from("# Exact body\r\nno-final-newline");
type Backend = "inline" | "file";
type Fence = "file-lock" | "database";
let database: ReturnType<typeof openNodeDaemonDatabase>;
let server: ReturnType<typeof createDaemonServer>;
let port = 0;
let token = "";
let ordinal = 0;

function call(path: string, init: { method?: string; body?: unknown; range?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.range === undefined ? {} : { range: init.range }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("HTTP fixture timed out")));
    outgoing.end(init.body === undefined ? undefined : JSON.stringify(init.body));
  });
}

function state(id: string) {
  return {
    row: database.prepare("SELECT first_fetched_at, row_version FROM handoffs WHERE id = ?").get(id),
    events: database
      .prepare("SELECT * FROM events WHERE handoff_id = ? AND event_type = 'ARTIFACT_FETCHED_FIRST_TIME'")
      .all(id),
  };
}

function fence(kind: Fence): () => void {
  if (kind === "file-lock") {
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() }),
    );
    return () => rmSync(lock, { force: true });
  }
  expect(setMoveFenceAndCountPending(database, process.pid, new Date().toISOString()).ok).toBe(true);
  return () => {
    expect(clearMoveFence(database).ok).toBe(true);
  };
}

async function fresh(backend: Backend): Promise<string> {
  const path = join(home, "sender", `body-${++ordinal}${backend === "inline" ? ".md" : ".bin"}`);
  writeFileSync(path, bytes);
  const created = await call("/api/v1/handoffs/import-path?as=sender", {
    method: "POST",
    body: {
      to: ["recipient"],
      title: "Fence body",
      path,
    },
  });
  expect(created.status, created.body).toBe(201);
  const id = JSON.parse(created.body).data.handoffs[0].handoffId as string;
  const record = database
    .prepare(
      "SELECT c.storage_key FROM handoffs h JOIN artifacts a ON a.id=h.current_artifact_id JOIN content_records c ON c.id=a.content_record_id WHERE h.id=?",
    )
    .get(id) as { storage_key: string | null };
  if (backend === "inline") expect(record.storage_key).toBeNull();
  else expect(typeof record.storage_key).toBe("string");
  return id;
}

function observeWarmPorts() {
  const real = handoffPorts.createNodeHandoffReadPorts({ database, env: { SORAGE_HOME: home } });
  const handles: ArtifactReadHandle[] = [];
  let closes = 0;
  let settlements = 0;
  const warm = {
    ...real,
    handoffs: {
      ...real.handoffs,
      recordFirstFetch: (...args: Parameters<typeof real.handoffs.recordFirstFetch>) => {
        settlements += 1;
        return real.handoffs.recordFirstFetch(...args);
      },
    },
    artifact: {
      ...real.artifact,
      openArtifactBody: (...args: Parameters<typeof real.artifact.openArtifactBody>) => {
        const opened = real.artifact.openArtifactBody(...args);
        if (!opened.ok) return opened;
        const handle = opened.value;
        handles.push(handle);
        let closed = false;
        return {
          ok: true as const,
          value: {
            ...handle,
            close() {
              handle.close();
              if (!closed) {
                closes += 1;
                closed = true;
              }
            },
          },
        };
      },
    },
  };
  const spy = vi.spyOn(handoffPorts, "createNodeHandoffReadPorts").mockImplementation((options) => {
    expect(options?.database).toBe(database);
    return warm;
  });
  return {
    warm,
    handles,
    get closes() {
      return closes;
    },
    get settlements() {
      return settlements;
    },
    restore: () => spy.mockRestore(),
  };
}

beforeAll(async () => {
  process.env.SORAGE_HOME = home;
  expect(initializeInstallation(createNodeInitPorts(), { vaultPath: join(home, "vault") }).ok).toBe(true);
  database = openNodeDaemonDatabase(join(home, "state"));
  const probe = createServer();
  port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  const stateDir = join(home, "state");
  const tokens = createNodeApiTokenStore({ stateDir });
  tokens.ensure();
  token = tokens.read() as string;
  server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: {
      installationId: JSON.parse(readFileSync(join(home, "vault", ".sorage-vault.json"), "utf8")).installationId,
      version: "9.9.99-fence",
    },
    auth: createSessionService({
      token: tokens,
      webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
      entropy: createNodeTokenEntropy(),
    }),
    tokenRotate: () => tokens.rotate(),
    config: createDaemonConfigService({ host: "127.0.0.1", port, startedAt: new Date().toISOString() }),
    domainRoutes: createDomainRoutes({ vaultPath: () => join(home, "vault"), config: undefined, database }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  for (const name of ["sender", "recipient", "outsider"]) {
    const dir = join(home, name);
    mkdirSync(dir);
    const created = await call("/api/v1/projects", { method: "POST", body: { name, dir, asUser: true } });
    expect(created.status, created.body).toBe(201);
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  rmSync(lock, { force: true });
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  database?.close();
  if (oldHome === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

const matrix = [
  { backend: "inline", fenceKind: "file-lock", actor: "as=recipient", range: undefined },
  { backend: "inline", fenceKind: "database", actor: "asUser=true", range: "bytes=0-0" },
  { backend: "file", fenceKind: "file-lock", actor: "asUser=true", range: "bytes=0-0" },
  { backend: "file", fenceKind: "database", actor: "as=recipient", range: undefined },
] as const;

describe("first-fetch writes on a warm shared operational DB", () => {
  it("rejects a lossy JSON body before a retained replacement-character receipt can replay", async () => {
    const key = "00112233-4455-4677-8899-aabbccddeeff";
    const input = { to: ["recipient"], title: "Exact Unicode", body: "\uFFFD", asUser: true, idempotencyKey: key };
    const created = await call("/api/v1/handoffs/import-path", { method: "POST", body: input });
    expect(created.status, created.body).toBe(201);
    const tables = ["handoffs", "artifacts", "content_records", "events", "idempotency_keys", "pending_fs_ops"];
    const snapshot = () => tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const refused = await call("/api/v1/handoffs/import-path", { method: "POST", body: { ...input, body: "\uD800" } });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(snapshot()).toEqual(before);
  });

  it.each(matrix)(
    "closes admitted HTTP $backend/$fenceKind/$actor before serving on a late fence",
    async ({ backend, fenceKind, actor, range }) => {
      const id = await fresh(backend);
      const observed = observeWarmPorts(); // Actual factory composed BEFORE either late fence.
      const before = state(id);
      const release = fence(fenceKind);
      try {
        const paused = await call(`/api/v1/handoffs/${id}/artifact/content?${actor}`, {
          ...(range === undefined ? {} : { range }),
        });
        expect(paused.status, paused.body).toBe(423);
        expect(JSON.parse(paused.body)).toMatchObject({ ok: false, error: { code: "SERVICE_PAUSED" } });
        expect(paused.body).not.toContain(bytes.toString());
        expect(observed.handles).toHaveLength(1);
        expect(observed.settlements).toBe(1);
        expect(observed.closes).toBe(1);
        // Inline close is intentionally a no-op: it owns no descriptor.
        if (backend === "file") expect(observed.handles[0]?.read(0, 1).ok).toBe(false);
        expect(state(id)).toEqual(before);
      } finally {
        release();
        observed.restore();
      }
      const served = await call(`/api/v1/handoffs/${id}/artifact/content?${actor}`, {
        ...(range === undefined ? {} : { range }),
      });
      expect(served.status).toBe(range === undefined ? 200 : 206);
      expect(served.body).toBe(range === undefined ? bytes.toString() : "#");
      expect((state(id).row as { row_version: number }).row_version).toBe(1);
      expect(state(id).events).toHaveLength(1);
      expect((await call(`/api/v1/handoffs/${id}/artifact/content?${actor}`)).status).toBe(200);
      expect(state(id).events).toHaveLength(1);
    },
  );

  it.each(matrix)(
    "guards already-prepared $backend/$fenceKind bodies at the actual write entry",
    async ({ backend, fenceKind, actor }) => {
      const id = await fresh(backend);
      const ports = handoffPorts.createNodeHandoffReadPorts({ database, env: { SORAGE_HOME: home } });
      const input = {
        path: join(home, "recipient"),
        userHome: home,
        as: actor === "as=recipient" ? "recipient" : undefined,
        asUser: actor === "asUser=true",
      };
      const prepared = prepareHandoffFetch(ports, input, id, { kind: "body" });
      if (!prepared.ok || prepared.value.kind !== "body") throw new Error(JSON.stringify(prepared));
      expect(prepared.value.body.read(0, 1)).toMatchObject({ ok: true });
      const before = state(id);
      const close = vi.spyOn(prepared.value.body, "close");
      const release = fence(fenceKind);
      try {
        const paused = prepared.value.settleFirstFetch();
        expect(paused).toMatchObject({ ok: false, error: { code: "SERVICE_PAUSED" } });
        if (!paused.ok)
          expect(paused.error.details).toMatchObject(
            fenceKind === "file-lock" ? { lockPath: lock } : { moveFencePid: process.pid },
          );
        expect(state(id)).toEqual(before);
      } finally {
        prepared.value.close();
        release();
      }
      expect(close).toHaveBeenCalledTimes(1);
      close.mockRestore();
      if (backend === "file") expect(prepared.value.body.read(0, 1).ok).toBe(false);
      expect(fetchHandoff(ports, input, id).ok).toBe(true);
      expect(fetchHandoff(ports, input, id).ok).toBe(true);
      expect(state(id).events).toHaveLength(1);
      expect((state(id).row as { row_version: number }).row_version).toBe(1);
    },
  );

  it.each(["file-lock", "database"] as const)("keeps quiet reads and privacy under a live %s fence", async (kind) => {
    const sender = await fresh("inline");
    const repeat = await fresh("file");
    const reveal = await fresh("inline");
    const range = await fresh("file");
    const deleted = await fresh("inline");
    expect((await call(`/api/v1/handoffs/${repeat}/artifact/content?as=recipient`)).status).toBe(200);
    expect(
      (
        await call(`/api/v1/handoffs/${deleted}/decline`, {
          method: "POST",
          body: { as: "recipient", reason: "Finish", expectedRowVersion: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/api/v1/handoffs/${deleted}/deletion-request`, {
          method: "POST",
          body: { asUser: true, expectedRowVersion: 2 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/api/v1/handoffs/${deleted}/deletion-approve`, {
          method: "POST",
          body: { asUser: true, confirm: true, expectedRowVersion: 3 },
        })
      ).status,
    ).toBe(200);
    const ids = [sender, repeat, reveal, range, deleted];
    const before = ids.map(state);
    const release = fence(kind);
    try {
      expect((await call(`/api/v1/handoffs/${sender}/artifact/content?as=sender`)).status).toBe(200);
      expect((await call(`/api/v1/handoffs/${repeat}/artifact/content?as=recipient`)).status).toBe(200);
      const revealed = await call(`/api/v1/handoffs/${reveal}/artifact/reveal?as=recipient`, {
        method: "POST",
        body: {},
      });
      expect(revealed.status, revealed.body).toBe(200);
      expect(readFileSync(JSON.parse(revealed.body).data.localPath)).toEqual(bytes);
      expect(
        (await call(`/api/v1/handoffs/${range}/artifact/content?as=recipient`, { range: "bytes=99999-" })).status,
      ).toBe(416);
      for (const id of [sender, deleted]) {
        const hidden = await call(`/api/v1/handoffs/${id}/artifact/content?as=outsider`);
        expect(hidden.status).toBe(404);
        expect(JSON.parse(hidden.body).error.code).toBe("HANDOFF_NOT_FOUND");
      }
      const tombstone = await call(`/api/v1/handoffs/${deleted}/artifact/content?as=recipient`);
      expect(tombstone.status).toBe(409);
      expect(JSON.parse(tombstone.body).error.code).toBe("HANDOFF_DELETED");
      expect(ids.map(state)).toEqual(before);
    } finally {
      release();
    }
  });
});
