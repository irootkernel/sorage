import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Memo, MemoPage } from "@sorage/core";
import { memoHttpFixture, value, code } from "../fixtures/memo-http";
import { cliData, memoCliFixture } from "../../../cli/test/fixtures/memo-cli";
const fixtures: Awaited<ReturnType<typeof memoHttpFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture(clock?: { now(): Date }, cli?: ReturnType<typeof memoCliFixture>) {
  const f = await memoHttpFixture(clock, cli);
  fixtures.push(f);
  return f;
}

describe("authenticated Memo HTTP application", () => {
  it("shares normalized historical receipts across JSON spelling and native CLI transports", async () => {
    const f = await fixture();
    const key = randomUUID();
    const headers = { "idempotency-key": key };
    const first = await f.call("/api/v1/memos", {
      method: "POST",
      headers,
      body: { title: "  Reminder  ", projectId: f.projectId, body: "한글\r\n�" },
    });
    expect(first.status).toBe(200);
    const memo = value(first).memo;
    const before = f.inventory();
    const replay = await f.call("/api/v1/memos", {
      method: "POST",
      headers: { ...headers, "idempotency-mode": "replay-only" },
      raw: Buffer.from(`{ "body": "\\uD55C글\\r\\n\\uFFFD", "projectId": "${f.projectId}", "title": "Reminder" }`),
    });
    expect(value(replay)).toEqual({ ...value(first), replayed: true });
    expect(replay.body.meta.requestId).not.toBe(first.body.meta.requestId);
    expect(
      cliData(
        f.run([
          "memo",
          "add",
          "--title",
          "Reminder",
          "--body",
          "한글\r\n�",
          "--idempotency-key",
          key,
          "--replay-only",
          "--json",
        ]),
      ),
    ).toEqual(value(replay));
    expect(f.inventory()).toEqual(before);
    expect(
      code(
        await f.call("/api/v1/memos", {
          method: "POST",
          headers,
          body: { projectId: f.projectId, title: "Reminder", body: "한글\n�" },
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const cliKey = randomUUID();
    const original = cliData(
      f.run([
        "memo",
        "update",
        memo.id,
        "--expected-row-version",
        "1",
        "--body",
        "",
        "--idempotency-key",
        cliKey,
        "--json",
      ]),
    );
    await f.restart();
    const recovered = await f.call(`/api/v1/memos/${memo.id}`, {
      method: "PATCH",
      headers: { "idempotency-key": cliKey, "idempotency-mode": "replay-only" },
      body: { body: "", expectedRowVersion: 1 },
    });
    expect(value(recovered)).toEqual({ ...original, replayed: true });
    expect(value(await f.call<Memo>(`/api/v1/memos/${memo.id}`)).rowVersion).toBe(2);
    expect(
      value(
        await f.call("/api/v1/memos", {
          method: "POST",
          headers,
          body: { projectId: f.projectId, title: "Reminder", body: "한글\r\n�" },
        }),
      ).memo.rowVersion,
    ).toBe(1);
  });

  it("rejects malformed raw bytes and JSON before either fresh or retained-key replay", async () => {
    const f = await fixture();
    const known = randomUUID();
    const body = { projectId: f.projectId, title: "�", body: "�" };
    expect(
      (await f.call("/api/v1/memos", { method: "POST", body, headers: { "idempotency-key": known } })).status,
    ).toBe(200);
    const before = f.inventory();
    const invalid = [[0xff], [0xc3, 0x28], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80]];
    for (const key of [randomUUID(), known]) {
      for (const field of ["title", "body"])
        for (const bytes of invalid) {
          const raw = Buffer.from(JSON.stringify({ ...body, [field]: "PLACEHOLDER" }));
          const offset = raw.indexOf("PLACEHOLDER");
          const result = await f.call("/api/v1/memos", {
            method: "POST",
            raw: Buffer.concat([raw.subarray(0, offset), Buffer.from(bytes), raw.subarray(offset + 11)]),
            headers: { "idempotency-key": key, "idempotency-mode": "replay-only" },
          });
          expect(result.status).toBe(422);
          expect(code(result)).toBe("MEMO_INVALID_INPUT");
        }
      for (const raw of [
        "{",
        "null",
        "[]",
        "true",
        JSON.stringify({ ...body, title: "\ud800" }),
        JSON.stringify({ ...body, body: "\udfff" }),
      ]) {
        const result = await f.call("/api/v1/memos", {
          method: "POST",
          raw: Buffer.from(raw),
          headers: { "idempotency-key": key },
        });
        expect(result.status).toBe(422);
        expect(code(result)).toBe("MEMO_INVALID_INPUT");
      }
    }
    expect(f.inventory()).toEqual(before);
    const freshKey = randomUUID();
    expect(
      code(
        await f.call("/api/v1/memos", {
          method: "POST",
          raw: Buffer.from([0xff]),
          headers: { "idempotency-key": freshKey },
        }),
      ),
    ).toBe("MEMO_INVALID_INPUT");
    expect(
      (await f.call("/api/v1/memos", { method: "POST", body, headers: { "idempotency-key": freshKey } })).status,
    ).toBe(200);
  });

  it("accepts split multibyte text and valid replacement characters but enforces both byte limits on known keys", async () => {
    const f = await fixture();
    const key = randomUUID();
    const body = { projectId: f.projectId, title: "한글😀", body: "�\r\n😀" };
    const bytes = Buffer.from(JSON.stringify(body));
    const result = await f.call("/api/v1/memos", {
      method: "POST",
      chunks: [...bytes].map((byte) => Buffer.from([byte])),
      headers: { "idempotency-key": key },
    });
    expect(value(result).memo.body).toBe(body.body);
    const before = f.inventory();
    for (const raw of [
      Buffer.from(JSON.stringify({ ...body, body: "x".repeat(65537) })),
      Buffer.from(" ".repeat(512 * 1024) + JSON.stringify(body)),
    ]) {
      const result = await f.call("/api/v1/memos", {
        method: "POST",
        raw,
        headers: { "idempotency-key": key, "idempotency-mode": "replay-only" },
      });
      expect(result.status).toBe(413);
      expect(code(result)).toBe("MEMO_TOO_LARGE");
    }
    expect(f.inventory()).toEqual(before);
  });

  it("requires authentication, exact modes, closed inputs, one read scope and supported methods", async () => {
    const f = await fixture();
    const body = { projectId: f.projectId, title: "Memo" };
    const before = f.inventory();
    expect((await f.call("/api/v1/memos", { method: "POST", body, bearer: null })).status).toBe(401);
    expect((await f.call("/api/v1/memos", { method: "POST", body, headers: { host: "evil.invalid" } })).status).toBe(
      421,
    );
    expect((await f.call("/api/v1/memos", { method: "DELETE" })).status).toBe(405);
    for (const mode of ["", "other", "execute,replay-only", ["execute", "execute"]]) {
      const result = await f.call("/api/v1/memos", { method: "POST", body, headers: { "idempotency-mode": mode } });
      expect(result.status).toBe(422);
      expect(code(result)).toBe("MEMO_INVALID_INPUT");
    }
    for (const headers of [
      { "idempotency-mode": "replay-only" },
      { "idempotency-mode": "replay-only", "idempotency-key": "bad" },
      { "idempotency-key": [randomUUID(), randomUUID()] },
    ])
      expect(code(await f.call("/api/v1/memos", { method: "POST", body, headers }))).toBe("MEMO_INVALID_INPUT");
    for (const changed of [
      { ...body, actor: "user" },
      { ...body, body: null },
      { ...body, state: "done" },
      { ...body, id: randomUUID() },
    ])
      expect(code(await f.call("/api/v1/memos", { method: "POST", body: changed }))).toBe("MEMO_INVALID_INPUT");
    for (const query of [
      "",
      `projectId=${f.projectId}&allProjects=true`,
      "allProjects=false",
      `projectId=${f.projectId}&projectId=${f.projectId}`,
      `projectId=${f.projectId}&limit=1e2`,
      `projectId=${f.projectId}&asUser=true`,
    ])
      expect(code(await f.call(`/api/v1/memos?${query}`))).toBe("MEMO_INVALID_INPUT");
    expect(
      code(await f.call(`/api/v1/memos?projectId=${f.projectId}`, { headers: { "idempotency-mode": "execute" } })),
    ).toBe("MEMO_INVALID_INPUT");
    expect(f.inventory()).toEqual(before);
    const good = await f.call("/api/v1/memos", { method: "POST", body });
    expect(good.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(good.headers["x-content-type-options"]).toBe("nosniff");
    expect(code(await f.call(`/api/v1/memos/${value(good).memo.id}?projectId=${f.otherId}`))).toBe("MEMO_NOT_FOUND");
    expect(value(await f.call<MemoPage>("/api/v1/memos?allProjects=true")).items).toHaveLength(1);
  });

  it("serializes concurrent changes and exposes all lifecycle receipts without new effects on replay", async () => {
    const f = await fixture();
    let memo = value(
      await f.call("/api/v1/memos", { method: "POST", body: { projectId: f.projectId, title: "Memo" } }),
    ).memo;
    const raced = await Promise.all([
      f.call(`/api/v1/memos/${memo.id}`, { method: "PATCH", body: { expectedRowVersion: 1, body: "Edited" } }),
      f.call(`/api/v1/memos/${memo.id}/done`, { method: "POST", body: { expectedRowVersion: 1 } }),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(code(raced.find((r) => r.status === 409) ?? (raced[0] as (typeof raced)[number]))).toBe(
      "ROW_VERSION_CONFLICT",
    );
    memo = value(await f.call<Memo>(`/api/v1/memos/${memo.id}`));
    if (memo.state === "done")
      memo = value(
        await f.call(`/api/v1/memos/${memo.id}/reopen`, {
          method: "POST",
          body: { expectedRowVersion: memo.rowVersion },
        }),
      ).memo;
    for (const operation of ["done", "reopen", "dismiss", "reopen"] as const) {
      const body = { expectedRowVersion: memo.rowVersion };
      const headers = { "idempotency-key": randomUUID() };
      const original = await f.call(`/api/v1/memos/${memo.id}/${operation}`, { method: "POST", body, headers });
      const before = f.inventory();
      expect(
        value(
          await f.call(`/api/v1/memos/${memo.id}/${operation}`, {
            method: "POST",
            body,
            headers: { ...headers, "idempotency-mode": "replay-only" },
          }),
        ),
      ).toEqual({ ...value(original), replayed: true });
      expect(f.inventory()).toEqual(before);
      memo = value(original).memo;
    }
  });

  it("uses the server lookup Clock at expiry and never writes on a replay-only miss", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const f = await fixture({ now: () => new Date(now) });
    const headers = { "idempotency-key": randomUUID() };
    const body = { projectId: f.projectId, title: "Time" };
    const original = value(await f.call("/api/v1/memos", { method: "POST", body, headers }));
    const before = f.inventory();
    now += 24 * 3600000 - 1;
    expect(
      value(
        await f.call("/api/v1/memos", {
          method: "POST",
          body,
          headers: { ...headers, "idempotency-mode": "replay-only" },
        }),
      ),
    ).toEqual({ ...original, replayed: true });
    for (const delta of [1, 1]) {
      now += delta;
      const result = await f.call("/api/v1/memos", {
        method: "POST",
        body,
        headers: { ...headers, "idempotency-mode": "replay-only" },
      });
      expect(result.status).toBe(409);
      expect(code(result)).toBe("MEMO_REPLAY_UNAVAILABLE");
    }
    expect(f.inventory()).toEqual(before);
    const unseen = randomUUID();
    expect(
      code(
        await f.call("/api/v1/memos", {
          method: "POST",
          body,
          headers: { "idempotency-key": unseen, "idempotency-mode": "replay-only" },
        }),
      ),
    ).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(f.inventory()).toEqual(before);
    expect(
      (await f.call("/api/v1/memos", { method: "POST", body, headers: { "idempotency-key": unseen } })).status,
    ).toBe(200);
  });

  it("keeps an in-flight original unknown until its eventual receipt exists", async () => {
    const f = await fixture();
    const headers = { "idempotency-key": randomUUID() };
    const body = { projectId: f.projectId, title: "Delayed original" };
    const before = f.inventory();
    const original = await f.call("/api/v1/memos", {
      method: "POST",
      body,
      headers,
      beforeEnd: async () => {
        const miss = await f.call("/api/v1/memos", {
          method: "POST",
          body,
          headers: { ...headers, "idempotency-mode": "replay-only" },
        });
        expect(code(miss)).toBe("MEMO_REPLAY_UNAVAILABLE");
        expect(f.inventory()).toEqual(before);
      },
    });
    expect(original.status).toBe(200);
    expect(
      value(
        await f.call("/api/v1/memos", {
          method: "POST",
          body,
          headers: { ...headers, "idempotency-mode": "replay-only" },
        }),
      ),
    ).toEqual({ ...value(original), replayed: true });
  });

  it("samples receipt expiry after delayed request input and keeps storage errors from executing", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const f = await fixture({ now: () => new Date(now) });
    const body = { projectId: f.projectId, title: "Boundary" };
    const headers = { "idempotency-key": randomUUID() };
    expect((await f.call("/api/v1/memos", { method: "POST", body, headers })).status).toBe(200);
    const before = f.inventory();
    now += 24 * 3600000 - 1;
    const late = await f.call("/api/v1/memos", {
      method: "POST",
      body,
      headers: { ...headers, "idempotency-mode": "replay-only" },
      beforeEnd: async () => {
        now += 1;
      },
    });
    expect(code(late)).toBe("MEMO_REPLAY_UNAVAILABLE");
    expect(f.inventory()).toEqual(before);
    f.db.exec("DROP TABLE idempotency_keys");
    const failure = await f.call("/api/v1/memos", {
      method: "POST",
      body,
      headers: { ...headers, "idempotency-mode": "replay-only" },
    });
    expect(code(failure)).toBe("INTERNAL_ERROR");
    expect(
      ["project_memos", "events"].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ).toEqual(before.slice(0, 2));
  });

  it.each([true, false])(
    "keeps restored unknown outcomes unavailable (snapshot contains Memo: %s)",
    async (containsMemo) => {
      const source = await fixture();
      const key = randomUUID();
      const body = { projectId: source.projectId, title: "Lost", body: "exact\r\n" };
      if (!containsMemo) expect(source.run(["backup", "run", "--as-user", "--json"]).status).toBe(0);
      const original = value(
        await source.call("/api/v1/memos", { method: "POST", body, headers: { "idempotency-key": key } }),
      );
      if (containsMemo) expect(source.run(["backup", "run", "--as-user", "--json"]).status).toBe(0);
      const target = memoCliFixture(true);
      const restored = target.run(
        ["backup", "restore", "--from", join(source.home, "vault"), "--confirm", "--as-user", "--json"],
        target.home,
      );
      expect(restored.status, restored.stderr).toBe(0);
      const f = await fixture(undefined, target);
      const before = f.inventory();
      const result = await f.call("/api/v1/memos", {
        method: "POST",
        body,
        headers: { "idempotency-key": key, "idempotency-mode": "replay-only" },
      });
      expect(result.status).toBe(409);
      expect(code(result)).toBe("MEMO_REPLAY_UNAVAILABLE");
      expect(
        target.run(
          [
            "memo",
            "add",
            "--project",
            "memo",
            "--title",
            "Lost",
            "--body",
            "exact\r\n",
            "--idempotency-key",
            key,
            "--replay-only",
            "--json",
          ],
          target.home,
        ).status,
      ).toBe(75);
      const shown = await f.call<Memo>(`/api/v1/memos/${original.memo.id}`);
      if (containsMemo) expect(value(shown)).toEqual(original.memo);
      else expect(code(shown)).toBe("MEMO_NOT_FOUND");
      expect(f.inventory()).toEqual(before);
    },
  );
});
