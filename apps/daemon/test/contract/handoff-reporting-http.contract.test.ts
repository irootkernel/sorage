import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { openNodeDaemonDatabase } from "@sorage/adapters/src/daemon-command-ports";
import { productionMigrationPlan } from "@sorage/adapters/src/sqlite/migrations";
import { openAndMigrate } from "@sorage/adapters/src/sqlite/migrator";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService } from "../../src/auth";
import { createDomainRoutes } from "../../src/domain-routes";
import { createDaemonServer } from "../../src/server";

const home = mkdtempSync(join(tmpdir(), "sorage-http-reporting-"));
const entry = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));
const sender = join(home, "sender");
const recipient = join(home, "recipient");
let port = 0;
let token = "";
let server: ReturnType<typeof createDaemonServer>;
let database: ReturnType<typeof openNodeDaemonDatabase>;
function cli(args: string[], cwd = sender) {
  const result = spawnSync("bun", [entry, ...args, "--json"], {
    cwd,
    env: { ...process.env, SORAGE_HOME: home },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).data;
}
function call(path: string, method = "GET", body?: unknown, auth = token, host?: string) {
  return new Promise<{ status: number; headers: Record<string, unknown>; value: ReturnType<typeof JSON.parse> }>(
    (resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          agent: false,
          headers: {
            ...(payload === undefined ? {} : { "content-length": String(payload.byteLength) }),
            host: host ?? `127.0.0.1:${port}`,
            authorization: `Bearer ${auth}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(payload);
    },
  );
}
function inventory(dir = home): unknown {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      return stat.isDirectory()
        ? [name, inventory(path)]
        : [name, stat.size, stat.mtimeMs, stat.ctimeMs, createHash("sha256").update(readFileSync(path)).digest("hex")];
    });
}
function domain() {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
  try {
    return Object.fromEntries(
      ["handoffs", "review_notes", "events", "artifacts", "content_records", "pending_fs_ops"].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
function sent() {
  return cli(["send", "--to", "recipient", "--title", "Report", "--body", "Document"]).handoffs[0].handoffId as string;
}
function base(id: string) {
  return `/api/v1/handoffs/${id}`;
}
async function state(id: string) {
  return (await call(`${base(id)}?as=recipient`)).value.data;
}
async function report(id: string, operation: string, body: unknown, actor = "recipient") {
  return call(`${base(id)}/${operation}?as=${actor}`, operation === "comment" ? "PUT" : "POST", body);
}
beforeAll(async () => {
  process.env.SORAGE_HOME = home;
  mkdirSync(sender);
  mkdirSync(recipient);
  cli(["init", "--non-interactive"]);
  for (const [name, dir] of [
    ["sender", sender],
    ["recipient", recipient],
    ["outsider", join(home, "outsider")],
  ]) {
    if (name === "outsider") mkdirSync(dir as string);
    cli(["project", "add", "--name", name as string, "--dir", dir as string]);
  }
  const stateDir = join(home, "state");
  const store = createNodeApiTokenStore({ stateDir });
  store.ensure();
  token = store.read() as string;
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  // Match production's daemon-lifetime connection: garbage collection of
  // request-owned connections must not checkpoint WAL during read assertions.
  database = openNodeDaemonDatabase(stateDir);
  server = createDaemonServer({
    host: "127.0.0.1",
    port,
    endpoints: { installationId: "reporting-test", version: "test" },
    auth: createSessionService({
      token: store,
      webSecret: createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } }),
      entropy: createNodeTokenEntropy(),
    }),
    domainRoutes: createDomainRoutes({ vaultPath: () => join(home, "vault"), config: undefined, database }),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
  delete process.env.SORAGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("authenticated HTTP Handoff reporting (HPR-013)", () => {
  it("pins four routes, fresh success envelopes and typed errors beside the CLI contract", async () => {
    const id = sent();
    const actual: Record<string, unknown> = {
      routes: createDomainRoutes({ vaultPath: () => null, config: undefined })
        .filter((route) => /\/comment$|\/processing\//.test(route.pattern))
        .map((route) => ({ method: route.method, path: route.pattern, legacyReplay: route.idempotent === true })),
    };
    for (const [name, operation, body] of [
      ["comment", "comment", { text: "Report", expectedRevision: 1, expectedRowVersion: 1 }],
      ["start", "processing/start", { comment: "Started", expectedRevision: 1, expectedRowVersion: 2 }],
      ["complete", "processing/complete", { comment: "Completed", expectedRevision: 1, expectedRowVersion: 3 }],
      ["repeated", "processing/complete", { expectedRevision: 1, expectedRowVersion: 4 }],
      ["missing-observation", "comment", { text: "Proposal" }],
    ] as const) {
      const result = await report(id, operation, body);
      actual[name] = { status: result.status, envelope: result.value };
    }
    const shown = await call(`${base(id)}/comment?as=sender`);
    actual.show = { status: shown.status, envelope: shown.value };
    const text = `${JSON.stringify(actual, null, 2)}\n`
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
    const golden = fileURLToPath(new URL("./golden/handoff-reporting-http.json", import.meta.url));
    if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(golden, text);
    expect(text).toBe(readFileSync(golden, "utf8"));
  });

  it("checks Host/auth before strict ingestion and hides unrelated participants on reads and writes", async () => {
    const id = sent();
    expect(
      (await call(`${base(id)}/comment?as=recipient`, "PUT", Buffer.from("invalid"), "invalid", "evil.invalid")).status,
    ).toBe(421);
    expect((await call(`${base(id)}/comment?as=recipient`, "PUT", Buffer.from("invalid"), "invalid")).status).toBe(401);
    for (const operation of ["comment", "processing/start", "processing/complete"]) {
      const body = {
        expectedRevision: 1,
        expectedRowVersion: 1,
        ...(operation === "comment" ? { text: "Proposal" } : {}),
      };
      expect((await report(id, operation, body, "outsider")).value.error.code).toBe("HANDOFF_NOT_FOUND");
      expect((await report(id, operation, body, "sender")).value.error.code).toBe("FORBIDDEN_ACTOR");
    }
    expect((await call(`${base(id)}/comment?as=outsider`)).value.error.code).toBe("HANDOFF_NOT_FOUND");
    const proxy = await call(`${base(id)}/comment?asUser=true`, "PUT", {
      text: "User report",
      expectedRevision: 1,
      expectedRowVersion: 1,
    });
    expect(proxy.value.data.comment).toMatchObject({
      authorKind: "user",
      authorProjectId: null,
      purpose: "general",
      active: false,
    });
    expect(proxy.headers["x-content-type-options"]).toBe("nosniff");
    expect(proxy.headers["x-request-id"]).toBe(proxy.value.meta.requestId);
  });

  it("strictly rejects JSON/UTF-8, unknown/local-file fields, text and observations without domain writes", async () => {
    const id = sent();
    const before = domain();
    const good = { text: "Hello", expectedRevision: 1, expectedRowVersion: 1 };
    for (const raw of [
      Buffer.from("{"),
      Buffer.from([0xff]),
      Buffer.from("[]"),
      Buffer.from("null"),
      Buffer.from('{"text":"a","te\\u0078t":"b","expectedRevision":1,"expectedRowVersion":1}'),
      {},
      { ...good, file: "/etc/passwd" },
      { ...good, text: 1 },
      { ...good, purpose: "reply" },
      { ...good, expectedRevision: 0 },
      { ...good, expectedRowVersion: 9007199254740992 },
      { ...good, expectedRevision: "1" },
      { ...good, text: "\ud800" },
      { ...good, text: "\u0000" },
      { ...good, text: "  " },
      { ...good, asUser: "true" },
    ]) {
      const response = await report(id, "comment", raw);
      expect(response.status, JSON.stringify(raw)).toBe(422);
      expect(response.value.error.code).toBe("HANDOFF_INVALID_INPUT");
    }
    for (const operation of ["processing/start", "processing/complete"]) {
      for (const extra of [
        { comment: null },
        { commentFile: "/etc/passwd" },
        { comment: "" },
        { expectedRevision: -1 },
      ])
        expect(
          (await report(id, operation, { expectedRevision: 1, expectedRowVersion: 1, ...extra })).value.error.code,
        ).toBe("HANDOFF_INVALID_INPUT");
    }
    const overflow = await report(id, "comment", { ...good, text: "x".repeat(1_048_576) });
    expect(overflow.value.error.code).toBe("CONFIG_INVALID");
    expect(domain()).toEqual(before);
  });

  it("preserves proposals/events on stale observations and keeps metadata/comment reads physically zero-write", async () => {
    const id = sent();
    const first = await report(id, "comment", { text: "  exact report\n", expectedRevision: 1, expectedRowVersion: 1 });
    expect(first.value.data.comment.body).toBe("  exact report\n");
    const before = domain();
    for (const operation of ["comment", "processing/start", "processing/complete"])
      for (const expectedRevision of [1, 2]) {
        const response = await report(id, operation, {
          expectedRevision,
          expectedRowVersion: 1,
          ...(operation === "comment" ? { text: "Keep proposal" } : { comment: "Keep proposal" }),
        });
        expect(response.value.error.code).toBe(expectedRevision === 2 ? "REVISION_CONFLICT" : "ROW_VERSION_CONFLICT");
      }
    expect(domain()).toEqual(before);
    const physical = inventory();
    for (const suffix of ["", "/comment", "/review-note", "/events", "/artifact"]) {
      const read = await call(`${base(id)}${suffix}?as=recipient`);
      expect(read.status).toBe(200);
      if (suffix === "") expect(read.value.data.comment).not.toHaveProperty("body");
    }
    expect(
      (await call(`/api/v1/handoffs?as=recipient`)).value.data.handoffs.find((item: { id: string }) => item.id === id)
        .comment,
    ).not.toHaveProperty("body");
    expect((await call(`${base(id)}/comment?as=outsider`)).status).toBe(404);
    expect(inventory()).toEqual(physical);
  });

  it("keeps processing independent of reading/acceptance and enforces terminal/archive/tombstone guards", async () => {
    const id = sent();
    const started = await report(id, "processing/start", {
      expectedRevision: 1,
      expectedRowVersion: 1,
      comment: "Started",
    });
    expect(started.value.data.handoff).toMatchObject({
      rowVersion: 2,
      reviewState: "awaiting_recipient",
      read: { status: "unconfirmed" },
      processing: { status: "in_progress" },
      firstFetchedAt: null,
    });
    const accepted = await call(`${base(id)}/accept?as=recipient`, "POST", {
      expectedRevision: 1,
      expectedRowVersion: 2,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.value.data.acceptedRevision).toBe(1);
    expect((await state(id)).processing.status).toBe("in_progress");
    const done = await report(id, "processing/complete", {
      expectedRevision: 1,
      expectedRowVersion: 3,
      comment: "Done",
    });
    expect(done.value.data.handoff).toMatchObject({
      reviewState: "accepted",
      rowVersion: 4,
      processing: { status: "completed" },
    });
    cli(["archive", id, "--as-user"]);
    const current = await state(id);
    const updated = await report(id, "comment", {
      expectedRevision: 1,
      expectedRowVersion: current.rowVersion,
      text: "Final",
    });
    expect(updated.value.data.handoff.reviewState).toBe("accepted");
    const before = domain();
    expect(
      (
        await report(id, "processing/start", {
          expectedRevision: 1,
          expectedRowVersion: updated.value.data.handoff.rowVersion,
        })
      ).value.error.code,
    ).toBe("PROCESSING_STATE_CONFLICT");
    expect(
      (
        await report(id, "comment", {
          expectedRevision: 1,
          expectedRowVersion: updated.value.data.handoff.rowVersion,
          text: "Change",
          purpose: "change_request",
        })
      ).value.error.code,
    ).toBe("HANDOFF_TERMINAL");
    expect(domain()).toEqual(before);
    const requested = cli(["delete", "request", id, "--as-user"]);
    const beforeDelete = domain();
    const staleDelete = await call(`${base(id)}/deletion-approve?asUser=true`, "POST", {
      confirm: true,
      expectedRowVersion: updated.value.data.handoff.rowVersion,
    });
    expect(staleDelete.value.error.code).toBe("ROW_VERSION_CONFLICT");
    expect(domain()).toEqual(beforeDelete);
    cli(["delete", "approve", id, "--as-user", "--confirm", "--expected-row-version", String(requested.rowVersion)]);
    expect((await call(`${base(id)}/comment?as=recipient`)).value.data).toBeNull();
    expect(
      (await report(id, "comment", { text: "Deleted", expectedRevision: 1, expectedRowVersion: 99 })).value.error.code,
    ).toBe("HANDOFF_DELETED");
    const direct = await report(sent(), "processing/complete", { expectedRevision: 1, expectedRowVersion: 1 });
    expect(direct.value.data.handoff.processing).toMatchObject({ status: "completed", startedAt: null });
  });

  it("replays the recorded revise result before fresh observations and refuses invalid scalars and receipt misses", async () => {
    const id = sent();
    await call(`${base(id)}/review-note?as=recipient`, "PUT", {
      text: "Request",
      targetRevision: 1,
      expectedRowVersion: 1,
    });
    const input = { noChange: true, reason: "Original", idempotencyKey: "http-report-replay" };
    const original = await call(`${base(id)}/revise?as=sender`, "POST", { ...input, expectedRowVersion: 2 });
    expect(original.status).toBe(200);
    await report(id, "comment", { text: "Later", expectedRevision: 1, expectedRowVersion: 3 });
    const before = domain();
    const replay = await call(`${base(id)}/revise?as=sender`, "POST", input);
    expect(replay.status).toBe(200);
    expect(replay.value.data).toEqual({ ...original.value.data, replayed: true });
    expect(
      (await call(`${base(id)}/revise?as=sender`, "POST", { ...input, expectedRowVersion: "2" })).value.error.code,
    ).toBe("HANDOFF_INVALID_INPUT");
    expect(
      (await call(`${base(id)}/revise?as=sender`, "POST", { ...input, idempotencyKey: "missing-http-report" })).value
        .error.code,
    ).toBe("HANDOFF_INVALID_INPUT");
    expect(domain()).toEqual(before);
  });

  it("refuses a genuine schema-11 database through covered comment/metadata reads without migration or logging", async () => {
    const legacyHome = join(home, "legacy-home");
    mkdirSync(legacyHome);
    const initialized = spawnSync("bun", [entry, "init", "--non-interactive"], {
      cwd: sender,
      env: { ...process.env, SORAGE_HOME: legacyHome },
      encoding: "utf8",
    });
    expect(initialized.status, initialized.stderr).toBe(0);
    const database = join(legacyHome, "state", "sorage.sqlite3");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    const plan = productionMigrationPlan();
    const old = openAndMigrate(
      database,
      plan.migrations.filter((migration) => migration.version <= 11),
      { rebuilds: plan.rebuilds },
    );
    old.db.close();
    const physical = inventory(legacyHome);
    process.env.SORAGE_HOME = legacyHome;
    try {
      for (const path of [
        "/api/v1/handoffs",
        ...["", "/comment", "/review-note", "/events", "/artifact"].map((suffix) => `${base("unknown")}${suffix}`),
      ]) {
        const refused = await call(`${path}?asUser=true`);
        expect(refused.value.error.code, path).toBe("STORAGE_MIGRATION_REQUIRED");
      }
      expect(inventory(legacyHome)).toEqual(physical);
    } finally {
      process.env.SORAGE_HOME = home;
    }
  });

  it("requires legacy observations and retains an inactive request on decline before general replacement", async () => {
    const id = sent();
    expect(
      (await call(`${base(id)}/review-note?as=recipient`, "PUT", { text: "Request", targetRevision: 1 })).value.error
        .code,
    ).toBe("HANDOFF_INVALID_INPUT");
    const requestResult = await call(`${base(id)}/review-note?as=recipient`, "PUT", {
      text: "Request",
      targetRevision: 1,
      expectedRowVersion: 1,
    });
    expect(requestResult.status).toBe(200);
    const before = domain();
    for (const [suffix, method, body] of [
      ["review-note/withdraw", "POST", {}],
      ["review-note", "DELETE", { asUser: true, confirm: true }],
      ["revise", "POST", { noChange: true, reason: "No change" }],
      ["deletion-approve", "POST", { asUser: true, confirm: true }],
    ] as const) {
      expect(
        (await call(`${base(id)}/${suffix}?as=${suffix === "revise" ? "sender" : "recipient"}`, method, body)).value
          .error.code,
      ).toBe("HANDOFF_INVALID_INPUT");
      expect(
        (
          await call(`${base(id)}/${suffix}?as=${suffix === "revise" ? "sender" : "recipient"}`, method, {
            ...body,
            expectedRowVersion: 1,
          })
        ).value.error.code,
      ).toBe(suffix === "deletion-approve" ? "HANDOFF_NOT_TERMINAL" : "ROW_VERSION_CONFLICT");
    }
    expect(domain()).toEqual(before);
    expect(
      (await report(id, "comment", { text: "General", expectedRevision: 1, expectedRowVersion: 2 })).value.error.code,
    ).toBe("REVIEW_NOTE_PRESENT");
    expect(
      (await report(id, "processing/complete", { expectedRevision: 1, expectedRowVersion: 2 })).value.error.code,
    ).toBe("REVIEW_NOTE_PRESENT");
    expect(
      (await call(`${base(id)}/decline?as=recipient`, "POST", { reason: "Stopped", expectedRowVersion: 2 })).status,
    ).toBe(200);
    expect((await call(`${base(id)}/review-note?as=recipient`)).value.data).toBeNull();
    expect((await call(`${base(id)}/comment?as=sender`)).value.data).toMatchObject({
      body: "Request",
      purpose: "change_request",
      active: false,
      targetRevision: 1,
    });
    const general = await report(id, "comment", { text: "Why stopped", expectedRevision: 1, expectedRowVersion: 3 });
    expect(general.value.data.handoff).toMatchObject({
      reviewState: "declined",
      processing: { status: "not_started", completedAt: null },
    });
    expect(general.value.data.comment).toMatchObject({ purpose: "general", active: false });
    expect(
      (await report(id, "processing/start", { expectedRevision: 1, expectedRowVersion: 4 })).value.error.code,
    ).toBe("HANDOFF_TERMINAL");
  });
});
