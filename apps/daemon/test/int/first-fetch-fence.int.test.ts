import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type ServerResponse } from "node:http";
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
import {
  type ArtifactReadHandle,
  appError,
  err,
  ok,
  fetchHandoff,
  reviseHandoff,
  withdrawHandoff,
  initializeInstallation,
  prepareHandoffFetch,
} from "@sorage/core";
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
let nextContentResponse: ((response: ServerResponse) => void) | undefined;

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
    row: database
      .prepare(
        "SELECT first_fetched_at, row_version, revision, current_artifact_id, read_status, read_revision, revision_read_at FROM handoffs WHERE id = ?",
      )
      .get(id),
    readEvents: database
      .prepare("SELECT * FROM events WHERE handoff_id = ? AND event_type = 'HANDOFF_REVISION_READ' ORDER BY rowid")
      .all(id),
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

async function fresh(backend: Backend, content: Buffer = bytes): Promise<string> {
  const path = join(home, "sender", `body-${++ordinal}${backend === "inline" ? ".md" : ".bin"}`);
  writeFileSync(path, content);
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
  server.prependListener("request", (incoming, response) => {
    if (!incoming.url?.includes("/artifact/content") || nextContentResponse === undefined) return;
    const configure = nextContentResponse;
    nextContentResponse = undefined;
    configure(response);
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

/** Script only the safely acquired handle; route admission, stream, SQLite and event settlement remain real. */
function deliveryPorts(
  failure?: "error" | "zero" | "truncated",
  options: { beforeRead?: () => void; throwReceipt?: boolean; closeFails?: boolean } = {},
) {
  const real = handoffPorts.createNodeHandoffReadPorts({ database, env: { SORAGE_HOME: home } });
  let closes = 0;
  let reads = 0;
  let releaseClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    releaseClosed = resolve;
  });
  const spy = vi.spyOn(handoffPorts, "createNodeHandoffReadPorts").mockReturnValue({
    ...real,
    handoffs: {
      ...real.handoffs,
      recordFirstFetch: (...args: Parameters<typeof real.handoffs.recordFirstFetch>) => {
        if (args[2] !== undefined && options.throwReceipt) throw new Error("injected post-delivery receipt failure");
        return real.handoffs.recordFirstFetch(...args);
      },
    },
    artifact: {
      ...real.artifact,
      openArtifactBody: (...args: Parameters<typeof real.artifact.openArtifactBody>) => {
        const opened = real.artifact.openArtifactBody(...args);
        if (!opened.ok) return opened;
        const handle = opened.value;
        let consumed = false;
        let readHookRan = false;
        return ok({
          ...handle,
          read(position: number, maxLength: number) {
            reads += 1;
            if (!readHookRan) {
              readHookRan = true;
              options.beforeRead?.();
            }
            if (failure === "error") return err(appError("ARTIFACT_CORRUPTED", "injected delivery read failure"));
            if (failure === "zero" || (failure === "truncated" && position > 0)) return ok(new Uint8Array(0));
            return handle.read(position, failure === "truncated" ? Math.ceil(handle.sizeBytes / 2) : maxLength);
          },
          close() {
            if (consumed) return;
            consumed = true;
            closes += 1;
            handle.close();
            releaseClosed();
            if (options.closeFails) throw new Error("injected delivery close failure");
          },
        });
      },
    },
  });
  return {
    real,
    closed,
    get closes() {
      return closes;
    },
    get reads() {
      return reads;
    },
    restore: () => spy.mockRestore(),
  };
}

function delivery(id: string, actor: string, abort = false, range?: string) {
  return new Promise<{ status: number; body: Buffer; aborted: boolean }>((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/v1/handoffs/${id}/artifact/content?${actor}`,
        agent: false,
        headers: { authorization: `Bearer ${token}`, ...(range === undefined ? {} : { range }) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (abort) outgoing.destroy();
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), aborted: false }),
        );
        response.on("aborted", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), aborted: true }),
        );
        response.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET")
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), aborted: true });
          else reject(error);
        });
      },
    );
    outgoing.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET")
        resolve({ status: 0, body: Buffer.alloc(0), aborted: true });
      else reject(error);
    });
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("delivery fixture timed out")));
    outgoing.end();
  });
}

const failedDeliveries = (["as=recipient", "asUser=true"] as const).flatMap((actor) =>
  (["inline", "file"] as const).flatMap((backend) =>
    (["error", "zero", "truncated"] as const).map((failure) => ({ actor, backend, failure })),
  ),
);

describe("HTTP current reading requires completed delivery (T131-R1-001)", () => {
  it.each(failedDeliveries)(
    "keeps $actor/$backend current reading absent after $failure",
    async ({ actor, backend, failure }) => {
      const id = await fresh(backend);
      const before = state(id);
      const observed = deliveryPorts(failure);
      try {
        const result = await delivery(id, actor);
        expect(result.aborted).toBe(true);
        await observed.closed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(observed.closes).toBe(1);
        const after = state(id);
        expect(after.row).toMatchObject({
          row_version: 1,
          read_status: "unconfirmed",
          read_revision: null,
          revision_read_at: null,
        });
        expect(after.readEvents).toEqual(before.readEvents);
        // The admitted fetch's independent historical protection must survive a later transport failure.
        expect(after.row).toMatchObject({ first_fetched_at: expect.any(String) });
        expect(after.events).toHaveLength(1);
        expect(
          withdrawHandoff(handoffPorts.createNodeTerminalPorts({ database, env: { SORAGE_HOME: home } }), {
            path: join(home, "sender"),
            userHome: home,
            as: "sender",
            asUser: false,
            handoffId: id,
            expectedRowVersion: 1,
          }),
        ).toMatchObject({ ok: false, error: { code: "HANDOFF_ALREADY_FETCHED" } });
      } finally {
        observed.restore();
      }
    },
  );

  it.each(["as=recipient", "asUser=true"])(
    "does not mark reading when %s aborts during real file backpressure",
    async (actor) => {
      const id = await fresh("file", Buffer.alloc(8 * 1024 * 1024, 0x61));
      const observed = deliveryPorts();
      try {
        expect((await delivery(id, actor, true)).aborted).toBe(true);
        await observed.closed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(observed.closes).toBe(1);
        expect(state(id).row).toMatchObject({
          first_fetched_at: expect.any(String),
          row_version: 1,
          read_status: "unconfirmed",
          revision_read_at: null,
        });
        expect(state(id).readEvents).toHaveLength(0);
        expect(state(id).events).toHaveLength(1);
      } finally {
        observed.restore();
      }
    },
  );
});

describe("HTTP successful delivery, identity and late failures (T131-R1-001)", () => {
  const successes = (["as=recipient", "asUser=true"] as const).flatMap((actor) =>
    (["inline", "file"] as const).flatMap((backend) =>
      [undefined, "bytes=1-3"].map((range) => ({ actor, backend, range })),
    ),
  );
  it.each(successes)(
    "settles $actor/$backend/$range exactly once after delivery",
    async ({ actor, backend, range }) => {
      const id = await fresh(backend);
      const before = state(id).row as { current_artifact_id: string };
      const result = await delivery(id, actor, false, range);
      expect(result).toMatchObject({ status: range === undefined ? 200 : 206, aborted: false });
      expect(result.body).toEqual(range === undefined ? bytes : bytes.subarray(1, 4));
      const settled = state(id);
      expect(settled.row).toMatchObject({
        first_fetched_at: expect.any(String),
        row_version: 1,
        read_status: "read",
        read_revision: 1,
        revision_read_at: expect.any(String),
      });
      expect(settled.events).toHaveLength(1);
      expect(settled.readEvents).toHaveLength(1);
      expect(JSON.parse((settled.readEvents[0] as { metadata_json: string }).metadata_json)).toEqual({
        revision: 1,
        artifactId: before.current_artifact_id,
      });
      expect((await delivery(id, actor)).aborted).toBe(false);
      expect(state(id)).toEqual(settled);
    },
  );

  it.each(["inline", "file"] as const)("keeps sender %s delivery free of recipient evidence", async (backend) => {
    const id = await fresh(backend);
    const before = state(id);
    const result = await delivery(id, "as=sender");
    expect(result).toMatchObject({ status: 200, aborted: false });
    expect(result.body).toEqual(bytes);
    expect(state(id)).toEqual(before);
  });

  it.each(["as=recipient", "asUser=true"])("waits for response finish before settling %s reading", async (actor) => {
    const id = await fresh("inline");
    let entered: () => void = () => {};
    const endQueued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume = () => {};
    nextContentResponse = (response) => {
      const original = response.end.bind(response);
      resume = () => {
        response.end = original;
        response.end();
      };
      response.end = (() => {
        entered();
        return response;
      }) as typeof response.end;
    };
    const result = delivery(id, actor);
    try {
      await endQueued;
      expect(state(id).row).toMatchObject({
        first_fetched_at: expect.any(String),
        read_status: "unconfirmed",
        revision_read_at: null,
      });
      expect(state(id).readEvents).toHaveLength(0);
    } finally {
      resume();
      nextContentResponse = undefined;
    }
    expect((await result).aborted).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state(id).row).toMatchObject({ read_status: "read", read_revision: 1 });
    expect(state(id).readEvents).toHaveLength(1);
  });

  it.each(
    (["as=recipient", "asUser=true"] as const).flatMap((actor) =>
      ["before-admission", "before-finish"].map((phase) => ({ actor, phase })),
    ),
  )("keeps current reading absent when $actor response closes $phase", async ({ actor, phase }) => {
    const id = await fresh("file");
    const observed = deliveryPorts();
    nextContentResponse = (response) => {
      if (phase === "before-admission") response.destroy();
      else
        response.end = (() => {
          response.destroy();
          return response;
        }) as typeof response.end;
    };
    try {
      await delivery(id, actor);
      await observed.closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observed.closes).toBe(1);
      expect(state(id).row).toMatchObject({
        first_fetched_at: phase === "before-admission" ? null : expect.any(String),
        read_status: "unconfirmed",
        revision_read_at: null,
      });
      expect(state(id).readEvents).toHaveLength(0);
      expect(state(id).events).toHaveLength(phase === "before-admission" ? 0 : 1);
      expect(observed.reads === 0).toBe(phase === "before-admission");
    } finally {
      nextContentResponse = undefined;
      observed.restore();
    }
  });

  it.each(
    (["as=recipient", "asUser=true"] as const).flatMap((actor) =>
      ["late-fence", "thrown-receipt", "close-failure"].map((failure) => ({ actor, failure })),
    ),
  )(
    "preserves delivered $actor bytes and independent read/cleanup outcomes on $failure",
    async ({ actor, failure }) => {
      const id = await fresh("file");
      let release = () => {};
      const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const observed = deliveryPorts(undefined, {
        beforeRead: () => {
          if (failure === "late-fence") release = fence("database");
        },
        throwReceipt: failure === "thrown-receipt",
        closeFails: failure === "close-failure",
      });
      try {
        const result = await delivery(id, actor);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(result).toMatchObject({ status: 200, aborted: false });
        expect(result.body).toEqual(bytes);
        expect(observed.closes).toBe(1);
        expect(state(id).row).toMatchObject({
          first_fetched_at: expect.any(String),
          row_version: 1,
          read_status: failure === "close-failure" ? "read" : "unconfirmed",
          read_revision: failure === "close-failure" ? 1 : null,
          revision_read_at: failure === "close-failure" ? expect.any(String) : null,
        });
        expect(state(id).readEvents).toHaveLength(failure === "close-failure" ? 1 : 0);
        expect(state(id).events).toHaveLength(1);
        if (failure === "close-failure") {
          const row = state(id).row as { current_artifact_id: string; revision: number };
          expect(JSON.parse((state(id).readEvents[0] as { metadata_json: string }).metadata_json)).toEqual({
            artifactId: row.current_artifact_id,
            revision: row.revision,
          });
        }
        expect(
          warnings.mock.calls.some((call) =>
            String(call[0]).includes(failure === "late-fence" ? "SERVICE_PAUSED" : "failed"),
          ),
        ).toBe(true);
        expect(warnings.mock.calls.every((call) => String(call[1]) === "SORAGE_COMPLETION")).toBe(true);
      } finally {
        release();
        observed.restore();
        warnings.mockRestore();
      }
    },
  );

  it.each(["as=recipient", "asUser=true"])(
    "does not turn truncated %s delivery into reading when cleanup also fails",
    async (actor) => {
      const id = await fresh("file");
      const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const observed = deliveryPorts("truncated", { closeFails: true });
      try {
        expect((await delivery(id, actor)).aborted).toBe(true);
        await observed.closed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(state(id).row).toMatchObject({
          first_fetched_at: expect.any(String),
          row_version: 1,
          read_status: "unconfirmed",
          revision_read_at: null,
        });
        expect(state(id).readEvents).toHaveLength(0);
        expect(state(id).events).toHaveLength(1);
        expect(observed.closes).toBe(1);
        expect(warnings.mock.calls.some((call) => String(call[0]).includes("cleanup failed"))).toBe(true);
      } finally {
        observed.restore();
        warnings.mockRestore();
      }
    },
  );

  const stale = (["as=recipient", "asUser=true"] as const).flatMap((actor) =>
    (["inline", "file"] as const).flatMap((backend) =>
      [false, true].map((newerRead) => ({ actor, backend, newerRead })),
    ),
  );
  it.each(stale)(
    "keeps $actor acquired old $backend identity separate from newerRead=$newerRead",
    async ({ actor, backend, newerRead }) => {
      const id = await fresh(backend);
      const observed = deliveryPorts(undefined, {
        beforeRead: () => {
          const revised = reviseHandoff(
            handoffPorts.createNodeRevisionPorts({ database, env: { SORAGE_HOME: home } }),
            {
              path: join(home, "sender"),
              userHome: home,
              as: "sender",
              asUser: false,
              handoffId: id,
              body: "New Revision",
              expectedRowVersion: 1,
            },
          );
          expect(revised.ok).toBe(true);
          if (newerRead)
            expect(
              fetchHandoff(
                observed.real,
                {
                  path: join(home, "recipient"),
                  userHome: home,
                  as: actor === "as=recipient" ? "recipient" : undefined,
                  asUser: actor === "asUser=true",
                },
                id,
              ).ok,
            ).toBe(true);
        },
      });
      try {
        const result = await delivery(id, actor);
        expect(result.body).toEqual(bytes);
        expect(result.aborted).toBe(false);
        const current = state(id);
        expect(current.row).toMatchObject({
          revision: 2,
          row_version: 2,
          first_fetched_at: expect.any(String),
          read_status: newerRead ? "read" : "unconfirmed",
          read_revision: newerRead ? 2 : null,
        });
        expect(current.events).toHaveLength(1);
        expect(current.readEvents).toHaveLength(newerRead ? 1 : 0);
        if (newerRead)
          expect(JSON.parse((current.readEvents[0] as { metadata_json: string }).metadata_json)).toEqual({
            revision: 2,
            artifactId: (current.row as { current_artifact_id: string }).current_artifact_id,
          });
      } finally {
        observed.restore();
      }
    },
  );
});
