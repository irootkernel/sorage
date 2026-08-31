import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, registerCleanup, runCleanups, sorage } from "./helpers";

/**
 * The daemon-restart row of the section 4 failure matrix (TASK-061): the daemon
 * is killed while a multipart upload is still streaming, the client sees a
 * transport failure, the next start drains and leaves no half-created Handoff,
 * and a retry with the same `Idempotency-Key` produces exactly one Handoff
 * (RUN-002, SEC-008, SEC-009).
 */
const home = makeTempDir("sorage-restart-midrequest-");
const boundary = "sorage-restart-boundary-9c31aa";
const bodySize = 256 * 1024;

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

function multipartBody(): Buffer {
  const filler = Buffer.alloc(bodySize, 0x62);
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nInterrupted\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\nalpha\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.md"\r\nContent-Type: text/markdown\r\n\r\n`,
    ),
    filler,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

interface UploadOutcome {
  settled: "response" | "transport-failure";
  status: number;
  body: string;
}

/** Starts an upload and streams it slowly; `killMidStream` runs during the pause. */
function slowUpload(
  port: number,
  token: string,
  idempotencyKey: string,
  killMidStream: () => void,
): Promise<UploadOutcome> {
  const body = multipartBody();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/v1/handoffs/upload",
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
        "idempotency-key": idempotencyKey,
      },
    });
    const chunks: Buffer[] = [];
    outgoing.on("response", (response) => {
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          settled: "response",
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    outgoing.on("error", () => resolve({ settled: "transport-failure", status: 0, body: "" }));
    // Write the head, pause so the daemon is mid-spool, then kill and finish.
    outgoing.write(body.subarray(0, 32 * 1024), () => {
      setTimeout(() => {
        killMidStream();
        outgoing.end(body.subarray(32 * 1024));
      }, 250);
    });
    const guard = setTimeout(() => reject(new Error("the interrupted upload never settled")), 10_000);
    void guard.unref?.();
  });
}

/** A complete upload used for the retry after the restart. */
function fullUpload(port: number, token: string, idempotencyKey: string): Promise<UploadOutcome> {
  const body = multipartBody();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/handoffs/upload",
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length),
          "idempotency-key": idempotencyKey,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            settled: "response",
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", () => resolve({ settled: "transport-failure", status: 0, body: "" }));
    outgoing.end(body);
    const guard = setTimeout(() => reject(new Error("the retried upload never settled")), 15_000);
    void guard.unref?.();
  });
}

afterAll(() => {
  runCleanups();
});

describe("a daemon killed mid-request", () => {
  it("drains cleanly and an idempotent retry creates exactly one Handoff", async () => {
    const port = await freePort();
    const work = makeTempDir("sorage-restart-workdir-");
    expect(sorage(["init", "--non-interactive", "--port", String(port)], { home }).status).toBe(0);
    expect(sorage(["project", "add", "--name", "Alpha", "--dir", work], { home }).status).toBe(0);
    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
    const token = readFileSync(`${home}/state/api-token`, "utf8").trim();
    registerCleanup(() => {
      sorage(["daemon", "stop"], { home });
    });

    const key = "restart-midrequest-key-1";
    const record = JSON.parse(readFileSync(`${home}/run/daemon.json`, "utf8")) as { pid: number };
    const interrupted = await slowUpload(port, token, key, () => {
      process.kill(record.pid, "SIGKILL");
    });
    expect(interrupted.settled).toBe("transport-failure");

    // The kill left no half-created Handoff behind.
    const inbox = sorage(["inbox", "--json", "--as", "alpha"], { home });
    expect(inbox.status).toBe(0);
    expect(JSON.parse(inbox.stdout).data.handoffs).toHaveLength(0);

    // The next start drains and recovers the stale record.
    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);

    const retried = await fullUpload(port, token, key);
    expect(retried.settled).toBe("response");
    expect(retried.status).toBe(201);
    const created = JSON.parse(retried.body) as { data: { handoffs: Array<{ handoffId: string }> } };
    expect(created.data.handoffs).toHaveLength(1);

    const replay = await fullUpload(port, token, key);
    expect(replay.status).toBe(201);
    const replayed = JSON.parse(replay.body) as { data: { handoffs: Array<{ handoffId: string }> } };
    expect(replayed.data.handoffs[0]?.handoffId).toBe(created.data.handoffs[0]?.handoffId);

    const doctor = sorage(["doctor", "--json"], { home });
    expect(doctor.status).toBe(0);
    const report = JSON.parse(doctor.stdout) as { data: { checks: Array<{ id: string; severity: string }> } };
    expect(report.data.checks.find((check) => check.id === "db.pendingIntents")?.severity).toBe("ok");
    expect(sorage(["vault", "verify", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);
  });
});
