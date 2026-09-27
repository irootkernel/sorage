import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope, Memo, MemoReceipt } from "../../packages/core/src/index";
import {
  twoProjectFixture,
  sorage,
  envelopeOf,
  errorEnvelopeOf,
  makeTempDir,
  registerCleanup,
  runCleanups,
  BINARY,
} from "./helpers";
afterEach(runCleanups);
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}
function data<T = MemoReceipt>(result: ReturnType<typeof sorage>): T {
  expect(result.status, result.stderr).toBe(0);
  return envelopeOf(result).data as T;
}
async function daemon(home: string) {
  const port = await freePort();
  data(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }));
  data(sorage(["daemon", "start", "--json"], { home }));
  registerCleanup(() => {
    sorage(["daemon", "stop"], { home });
  });
  const token = readFileSync(join(home, "state", "api-token"), "utf8").trim();
  async function call<T = MemoReceipt>(path: string, method: string, body?: unknown, key?: string, mode?: string) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
        ...(mode ? { "idempotency-mode": mode } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Envelope<T> };
  }
  return { port, token, call };
}
function httpData<T>(result: { status: number; body: Envelope<T> }): T {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  if (!result.body.ok) throw new Error(JSON.stringify(result.body));
  return result.body.data;
}

describe("AJ-22: compiled CLI and authenticated daemon recovery", () => {
  it("delivers a complete full-size Memo JSON response to a slow pipe consumer", async () => {
    const f = twoProjectFixture("aj22-output");
    const body = "😀".repeat(16384);
    const file = join(f.home, "large.md");
    writeFileSync(file, body);
    expect(
      sorage(["memo", "add", "--project", "alpha", "--title", "Full response", "--body-file", file], { home: f.home })
        .status,
    ).toBe(0);
    const child = spawn(BINARY, ["memo", "list", "--project", "alpha", "--json"], {
      env: { ...process.env, SORAGE_HOME: f.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let listing = "";
    child.stdout.on("data", (chunk) => {
      listing += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("list failed"))));
    });
    const id = JSON.parse(listing).data.items[0].id as string;
    const showing = spawn(BINARY, ["memo", "show", id, "--json"], {
      env: { ...process.env, SORAGE_HOME: f.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = new Promise<string>((resolve, reject) => {
      let output = "";
      showing.stdout.setEncoding("utf8");
      showing.stdout.on("data", (chunk) => {
        output += chunk;
      });
      showing.stdout.pause();
      showing.on("error", reject);
      showing.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("show failed"))));
      setTimeout(() => showing.stdout.resume(), 200);
    });
    expect(JSON.parse(await result).data.body === body).toBe(true);
  });

  it.each(["update", "done"] as const)("fences a compiled CLI update racing an HTTP %s", async (operation) => {
    const f = twoProjectFixture("aj22-race");
    const original = data(
      sorage(["memo", "add", "--project", "alpha", "--title", "Race", "--body", "Original", "--json"], {
        home: f.home,
      }),
    ).memo;
    const server = await daemon(f.home);
    const cliKey = randomUUID();
    const httpKey = randomUUID();
    const args = [
      "memo",
      "update",
      original.id,
      "--body",
      "CLI winner",
      "--expected-row-version",
      "1",
      "--idempotency-key",
      cliKey,
      "--json",
    ];
    const request = operation === "update" ? { expectedRowVersion: 1, body: "HTTP winner" } : { expectedRowVersion: 1 };
    const path = `/memos/${original.id}${operation === "done" ? "/done" : ""}`;
    const method = operation === "update" ? "PATCH" : "POST";
    const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
    try {
      const events = () => db.prepare("SELECT * FROM events WHERE memo_id=? ORDER BY rowid").all(original.id);
      const before = events().length;
      // Hold a real SQLite writer fence while starting both independent production clients.
      db.exec("BEGIN IMMEDIATE");
      const child = spawn(BINARY, args, {
        cwd: f.workA,
        env: { ...process.env, SORAGE_HOME: f.home, SORAGE_TEST_REQUEST_ID: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const cliPending = new Promise<ReturnType<typeof sorage>>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      const httpPending = server.call(path, method, request, httpKey);
      await new Promise((resolve) => setTimeout(resolve, 100));
      db.exec("COMMIT");
      const [cli, http] = await Promise.all([cliPending, httpPending]);
      expect([cli.status === 0, http.status === 200].filter(Boolean)).toHaveLength(1);
      const winner = cli.status === 0 ? data(cli) : httpData(http);
      if (cli.status === 0) expect(http.body).toMatchObject({ ok: false, error: { code: "ROW_VERSION_CONFLICT" } });
      else {
        expect(cli.status).toBe(75);
        expect(errorEnvelopeOf(cli).error.code).toBe("ROW_VERSION_CONFLICT");
      }
      expect(winner.memo.rowVersion).toBe(2);
      expect(winner.memo.body).toBe(
        cli.status === 0 ? "CLI winner" : operation === "update" ? "HTTP winner" : "Original",
      );
      expect(winner.memo.state).toBe(cli.status === 0 || operation === "update" ? "open" : "done");
      expect(data<Memo>(sorage(["memo", "show", original.id, "--json"], { home: f.home }))).toEqual(winner.memo);
      expect(events()).toHaveLength(before + 1);
      expect(db.prepare("SELECT * FROM idempotency_keys WHERE key IN (?, ?)").all(cliKey, httpKey)).toHaveLength(1);
      const replay =
        cli.status === 0
          ? httpData(
              await server.call(
                `/memos/${original.id}`,
                "PATCH",
                { body: "CLI winner", expectedRowVersion: 1 },
                cliKey,
                "replay-only",
              ),
            )
          : data(
              sorage(
                [
                  "memo",
                  operation,
                  original.id,
                  ...(operation === "update" ? ["--body", "HTTP winner"] : []),
                  "--expected-row-version",
                  "1",
                  "--idempotency-key",
                  httpKey,
                  "--replay-only",
                  "--json",
                ],
                { home: f.home },
              ),
            );
      expect(replay).toEqual({ ...winner, replayed: true });
      expect(events()).toHaveLength(before + 1);
    } finally {
      db.close();
    }
  });

  it("recovers response loss after daemon restart, then keeps restored receipts unavailable across transports", async () => {
    const f = twoProjectFixture("aj22");
    const project = data<{ project: { id: string } }>(sorage(["project", "show", "alpha", "--json"], { home: f.home }))
      .project.id;
    const body = "한글 😀\r\n� exact body\n";
    const file = join(f.home, "memo.md");
    writeFileSync(file, body);
    const cliKey = randomUUID();
    const original = data(
      sorage(
        [
          "memo",
          "add",
          "--project",
          "alpha",
          "--title",
          "  Cross transport  ",
          "--body-file",
          file,
          "--idempotency-key",
          cliKey,
          "--json",
        ],
        { home: f.home },
      ),
    );
    let server = await daemon(f.home);
    const replay = httpData(
      await server.call(
        "/memos",
        "POST",
        { body, title: "Cross transport", projectId: project },
        cliKey,
        "replay-only",
      ),
    );
    expect(replay).toEqual({ ...original, replayed: true });
    const updateKey = randomUUID();
    const updated = httpData(
      await server.call(`/memos/${original.memo.id}`, "PATCH", { expectedRowVersion: 1, body: "" }, updateKey),
    );
    expect(
      data(
        sorage(
          [
            "memo",
            "update",
            original.memo.id,
            "--body",
            "",
            "--expected-row-version",
            "1",
            "--idempotency-key",
            updateKey,
            "--replay-only",
            "--json",
          ],
          { home: f.home },
        ),
      ),
    ).toEqual({ ...updated, replayed: true });

    const key = randomUUID();
    const requestBody = { projectId: project, title: "Lost HTTP response", body: "Keep one" };
    // Discard the real response after headers prove the handler reached its post-commit response.
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/v1/memos",
          method: "POST",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          response.destroy();
          request.destroy();
          resolve();
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(requestBody));
    });
    const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
    const inventory = () =>
      ["project_memos", "events", "idempotency_keys"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    try {
      const before = inventory();
      data(sorage(["daemon", "stop", "--json"], { home: f.home }));
      server = await daemon(f.home);
      const recovered = httpData(await server.call("/memos", "POST", requestBody, key, "replay-only"));
      expect(recovered.replayed).toBe(true);
      expect(recovered.memo.title).toBe(requestBody.title);
      expect(inventory()).toEqual(before);
      expect(data<Memo>(sorage(["memo", "show", recovered.memo.id, "--json"], { home: f.home }))).toEqual(
        recovered.memo,
      );
      data(sorage(["daemon", "stop", "--json"], { home: f.home }));
      data(sorage(["backup", "run", "--as-user", "--json"], { home: f.home }));
      const target = makeTempDir("aj22-restored-");
      data(sorage(["init", "--non-interactive", "--json"], { home: target }));
      data(
        sorage(["backup", "restore", "--from", join(f.home, "vault"), "--as-user", "--confirm", "--json"], {
          home: target,
        }),
      );
      const restored = await daemon(target);
      const targetDb = new DatabaseSync(join(target, "state", "sorage.sqlite3"));
      try {
        const snapshot = () =>
          ["project_memos", "events", "idempotency_keys"].map((table) =>
            targetDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          );
        const baseline = snapshot();
        const unavailable = await restored.call("/memos", "POST", requestBody, key, "replay-only");
        expect(unavailable.status).toBe(409);
        expect(unavailable.body).toMatchObject({ ok: false, error: { code: "MEMO_REPLAY_UNAVAILABLE" } });
        const cli = sorage(
          [
            "memo",
            "add",
            "--project",
            "alpha",
            "--title",
            requestBody.title,
            "--body",
            requestBody.body,
            "--idempotency-key",
            key,
            "--replay-only",
            "--json",
          ],
          { home: target },
        );
        expect(cli.status).toBe(75);
        expect(errorEnvelopeOf(cli).error.code).toBe("MEMO_REPLAY_UNAVAILABLE");
        expect(httpData(await restored.call<Memo>(`/memos/${recovered.memo.id}`, "GET"))).toEqual(recovered.memo);
        expect(snapshot()).toEqual(baseline);
      } finally {
        targetDb.close();
      }
    } finally {
      db.close();
    }
  });
});
