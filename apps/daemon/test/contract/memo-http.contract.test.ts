import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoRoutes } from "../../src/memo-routes";
import { memoHttpFixture, value } from "../fixtures/memo-http";

function normalize(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
}
describe("Memo HTTP additive contract", () => {
  it("pins all seven routes, fresh receipts and errors outside the legacy transport cache", async () => {
    const f = await memoHttpFixture();
    try {
      const actual: Record<string, unknown> = {
        routes: createMemoRoutes().map((route) => ({
          method: route.method,
          path: route.pattern,
          legacyReplay: route.idempotent === true,
        })),
      };
      async function capture(name: string, path: string, options: Parameters<typeof f.call>[1] = {}, status = 200) {
        const result = await f.call(path, options);
        expect(result.status, JSON.stringify(result.body)).toBe(status);
        expect(result.headers["content-security-policy"]).toContain("default-src 'self'");
        expect(result.headers["x-content-type-options"]).toBe("nosniff");
        expect(result.headers["referrer-policy"]).toBe("no-referrer");
        actual[name] = { status: result.status, envelope: result.body };
        return result;
      }
      const key = randomUUID();
      const body = { projectId: f.projectId, title: "Memo", body: "한글\r\n�" };
      let memo = value(
        await capture("add", "/api/v1/memos", { method: "POST", body, headers: { "idempotency-key": key } }),
      ).memo;
      await capture("list", `/api/v1/memos?projectId=${f.projectId}`);
      await capture("show", `/api/v1/memos/${memo.id}`);
      for (const operation of ["update", "done", "reopen", "dismiss"]) {
        memo = value(
          await capture(operation, `/api/v1/memos/${memo.id}${operation === "update" ? "" : `/${operation}`}`, {
            method: operation === "update" ? "PATCH" : "POST",
            body: { expectedRowVersion: memo.rowVersion, ...(operation === "update" ? { body: "" } : {}) },
          }),
        ).memo;
      }
      await capture("historical-replay", "/api/v1/memos", {
        method: "POST",
        body,
        headers: { "idempotency-key": key, "idempotency-mode": "replay-only" },
      });
      await capture("stale", `/api/v1/memos/${memo.id}/done`, { method: "POST", body: { expectedRowVersion: 1 } }, 409);
      await capture("missing-expectation", `/api/v1/memos/${memo.id}/done`, { method: "POST", body: {} }, 422);
      await capture(
        "unavailable",
        "/api/v1/memos",
        { method: "POST", body, headers: { "idempotency-key": randomUUID(), "idempotency-mode": "replay-only" } },
        409,
      );
      await capture("invalid-utf8", "/api/v1/memos", { method: "POST", raw: Buffer.from([0xff]) }, 422);
      await capture("too-large", "/api/v1/memos", { method: "POST", raw: Buffer.alloc(512 * 1024 + 1, 0x20) }, 413);
      const path = fileURLToPath(new URL("./golden/memo-http.json", import.meta.url));
      const text = normalize(`${JSON.stringify(actual, null, 2)}\n`);
      if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(path, text);
      expect(text).toBe(readFileSync(path, "utf8"));
    } finally {
      await f.cleanup();
    }
  });
});
