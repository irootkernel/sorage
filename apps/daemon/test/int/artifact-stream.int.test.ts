import { createServer, get, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { ArtifactReadHandle } from "@sorage/core";
import { streamArtifactBody } from "../../src/domain-routes";

/**
 * The bounded serving stream of M3-P3 (section 18.4, NFR-005): the helper
 * reads the SAME scripted handle the route validated, completes a healthy
 * body, terminates visibly on zero progress before the admitted end or on a
 * client that stops mid-backpressure, answers immediately for an
 * already-stopped response instead of retaining the handle on a pending
 * drain wait, and reports a descriptor close failure separately after the
 * response terminates, retaining its successful-delivery fact. Every case runs over a
 * real socket with bounded timeouts.
 */

const MIB = 1024 * 1024;
const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers.reverse()) await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Scripted {
  handle: ArtifactReadHandle;
  closeCount: () => number;
}

function scriptedHandle(sizeBytes: number, options: { closeFails?: boolean; zeroAt?: number } = {}): Scripted {
  let closed = false;
  let closes = 0;
  return {
    closeCount: () => closes,
    handle: {
      sizeBytes,
      read(position: number, maxLength: number) {
        if (closed) {
          return { ok: false as const, error: { code: "ARTIFACT_CORRUPTED", message: "closed" } };
        }
        if (options.zeroAt !== undefined && position >= options.zeroAt) {
          return { ok: true as const, value: new Uint8Array(0) };
        }
        const length = Math.min(maxLength, sizeBytes - position);
        if (length <= 0) return { ok: true as const, value: new Uint8Array(0) };
        return { ok: true as const, value: Buffer.alloc(length, 0x61) };
      },
      close() {
        if (closed) return;
        closed = true;
        closes += 1;
        if (options.closeFails === true) throw new Error("injected close failure");
      },
    },
  };
}

function listen(handler: (response: ServerResponse) => unknown): Promise<number> {
  const server = createServer((_request, response) => {
    void handler(response);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function withTimeout<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bounded stream wait timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getBody(port: number): Promise<{ status: number; body: Buffer; aborted: boolean }> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const outgoing = get({ host: "127.0.0.1", port }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), aborted: false }),
        );
        response.on("aborted", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), aborted: true }),
        );
      });
      outgoing.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
          resolve({ status: 0, body: Buffer.alloc(0), aborted: true });
          return;
        }
        reject(error);
      });
    }),
  );
}

describe("streamArtifactBody over a real socket", () => {
  it("completes a healthy multi-chunk body and closes the descriptor once", async () => {
    const scripted = scriptedHandle(3 * MIB);
    const port = await listen((response) =>
      streamArtifactBody(scripted.handle, response, 0, scripted.handle.sizeBytes - 1),
    );
    const received = await getBody(port);
    expect(received.aborted).toBe(false);
    expect(received.body.byteLength).toBe(3 * MIB);
    expect(scripted.closeCount()).toBe(1);
  });

  it("terminates visibly on zero progress before the admitted end", async () => {
    const scripted = scriptedHandle(2 * MIB, { zeroAt: MIB });
    const port = await listen((response) =>
      streamArtifactBody(scripted.handle, response, 0, scripted.handle.sizeBytes - 1),
    );
    const received = await getBody(port);
    // The truncated connection is the visible failure: never a silent short
    // body that claims the promised length.
    expect(received.aborted).toBe(true);
    expect(scripted.closeCount()).toBe(1);
  });

  it("answers immediately for an already-stopped response without retaining the handle", async () => {
    const scripted = scriptedHandle(MIB);
    const port = await listen((response) => {
      response.destroy();
      return streamArtifactBody(scripted.handle, response, 0, scripted.handle.sizeBytes - 1);
    });
    await withTimeout(getBody(port).catch(() => ({ status: 0, body: Buffer.alloc(0), aborted: true })));
    expect(scripted.closeCount()).toBe(1);
  });

  it("retains successful finish while reporting descriptor cleanup failure separately", async () => {
    const scripted = scriptedHandle(64 * 1024, { closeFails: true });
    let observed: Awaited<ReturnType<typeof streamArtifactBody>> | undefined;
    const port = await listen(async (response) => {
      observed = await streamArtifactBody(scripted.handle, response, 0, scripted.handle.sizeBytes - 1);
    });
    const received = await getBody(port);
    expect(received.aborted).toBe(false);
    expect(received.body.byteLength).toBe(64 * 1024);
    await withTimeout(new Promise<void>((resolve) => setImmediate(resolve)));
    expect(observed?.delivered).toBe(true);
    expect(observed?.closeFailure?.error).toBeInstanceOf(Error);
    expect((observed?.closeFailure?.error as Error).message).toBe("injected close failure");
  });

  it("stops reading and closes the descriptor when the client aborts mid-backpressure", async () => {
    const scripted = scriptedHandle(8 * MIB);
    const finished = { done: false };
    const port = await listen(async (response) => {
      await streamArtifactBody(scripted.handle, response, 0, scripted.handle.sizeBytes - 1);
      finished.done = true;
    });
    const aborted = await withTimeout(
      new Promise<boolean>((resolve, reject) => {
        const outgoing = request({ host: "127.0.0.1", port, method: "GET" }, (response) => {
          response.once("data", () => outgoing.destroy());
          response.on("aborted", () => resolve(true));
          response.on("end", () => resolve(false));
        });
        outgoing.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(true);
          else reject(error);
        });
        outgoing.end();
      }),
    );
    expect(aborted).toBe(true);
    // The stopped response releases the backpressure wait and the descriptor
    // without spinning or waiting for a drain that never arrives.
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          if (scripted.closeCount() >= 1) {
            resolve();
            return;
          }
          if (Date.now() - started > 5_000) {
            reject(new Error("the descriptor was not closed after the client aborted"));
            return;
          }
          setImmediate(poll);
        };
        poll();
      }),
    );
    expect(finished.done).toBe(true);
  });
});
