import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configPutOnce } from "../../src/main";

/**
 * The TASK-070 retry proof against a scripted server (SEC-020, section 17.1):
 * the server holds the fresh token and the file starts with the stale one, so
 * the routed change's first GET meets 401 TOKEN_INVALID; the retry re-reads the
 * file - which the server has meanwhile rewritten to the fresh value, exactly
 * as a completed rotation would leave it - and the change lands. The PUT count
 * stays one in both the retry case and the refuse case, because a rotation can
 * never cause a write to run twice.
 */
const STALE = "s".repeat(64);
const FRESH = "f".repeat(64);

const homes: string[] = [];
let server: Server;
let port = 0;
let tokenOnFile = STALE;
let getCount = 0;
let putCount = 0;
let refusePut = false;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const free = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(free));
    });
    probe.on("error", reject);
  });
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "sorage-retry-int-"));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "api-token"), STALE, "utf8");
  port = await freePort();
  server = createServer((request, response) => {
    const bearer = String(request.headers.authorization ?? "");
    if (request.method === "GET") {
      getCount += 1;
      if (bearer !== `Bearer ${FRESH}`) {
        // A completed rotation left the fresh value on disk: hand it to the
        // retry exactly as the token file would.
        tokenOnFile = FRESH;
        writeFileSync(join(home, "state", "api-token"), FRESH, "utf8");
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: { code: "TOKEN_INVALID", message: "rotated" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", etag: '"e-1"' });
      response.end(JSON.stringify({ ok: true, data: { config: {} } }));
      return;
    }
    putCount += 1;
    const accepted = !refusePut && bearer === `Bearer ${FRESH}`;
    response.writeHead(accepted ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(accepted ? { ok: true } : { ok: false, error: { code: "TOKEN_INVALID" } }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
});

afterAll(() => {
  server.close();
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

describe("the routed read's rotation retry", () => {
  it("retries the GET exactly once with the re-read token and writes exactly once", async () => {
    const outcome = await configPutOnce("127.0.0.1", port, "server.port", "46321");
    expect(outcome).not.toBeNull();
    if (outcome === null) return;
    expect(outcome.ok).toBe(true);
    // One refused GET plus one retried GET, and a single PUT under the fresh token.
    expect(getCount).toBe(2);
    expect(putCount).toBe(1);
    expect(tokenOnFile).toBe(FRESH);
  });

  it("never retries the PUT when the mutation itself meets TOKEN_INVALID", async () => {
    getCount = 0;
    putCount = 0;
    refusePut = true;
    // The file now holds FRESH, so the GET succeeds and only the PUT refuses:
    // the refused mutation surfaces without a second attempt.
    const outcome = await configPutOnce("127.0.0.1", port, "server.port", "46322");
    expect(outcome).not.toBeNull();
    if (outcome === null) return;
    expect(outcome.ok).toBe(false);
    expect(getCount).toBe(1);
    expect(putCount).toBe(1);
    const body = outcome.body as { error?: { code?: string } };
    expect(body.error?.code).toBe("TOKEN_INVALID");
    refusePut = false;
  });
});
