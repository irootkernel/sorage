import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, registerCleanup, runCleanups, sorage, writeDocument } from "./helpers";

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
        agent: false,
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
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        // The daemon already died on its own; the transport failure this case
        // asserts is then already on its way, and the kill must not throw
        // uncaught inside the timer callback.
      }
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
    const created = JSON.parse(retried.body) as {
      data: { handoffs: Array<{ handoffId: string }> };
      meta: { requestId: string };
    };
    expect(created.data.handoffs).toHaveLength(1);

    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
    const replay = await fullUpload(port, token, key);
    expect(replay.status).toBe(201);
    const replayed = JSON.parse(replay.body);
    expect(replayed.data.replayed).toBe(true);
    expect(replayed.meta.requestId).not.toBe(created.meta.requestId);
    expect(replayed.data.handoffs[0]?.handoffId).toBe(created.data.handoffs[0]?.handoffId);

    const doctor = sorage(["doctor", "--json"], { home });
    expect(doctor.status).toBe(0);
    const report = JSON.parse(doctor.stdout) as { data: { checks: Array<{ id: string; severity: string }> } };
    expect(report.data.checks.find((check) => check.id === "db.pendingIntents")?.severity).toBe("ok");
    expect(sorage(["vault", "verify", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);
  });
});

describe("CLI receipts survive across daemon lifetimes", () => {
  it("reuses the same receipt in both directions for all six HTTP operations", async () => {
    const testHome = makeTempDir("sorage-cross-receipt-");
    const port = await freePort();
    const alpha = makeTempDir("sorage-cross-alpha-");
    const beta = makeTempDir("sorage-cross-beta-");
    const command = (args: string[], cwd?: string) => {
      const run = sorage([...args, "--json"], { home: testHome, cwd });
      expect(run.status, `${args.join(" ")}: ${run.stderr}`).toBe(0);
      return JSON.parse(run.stdout).data;
    };
    command(["init", "--non-interactive", "--port", String(port)]);
    command(["project", "add", "--name", "Alpha", "--dir", alpha]);
    command(["project", "add", "--name", "Beta", "--dir", beta]);
    const token = readFileSync(`${testHome}/state/api-token`, "utf8").trim();
    registerCleanup(() => {
      sorage(["daemon", "stop"], { home: testHome });
    });

    const sentBody = "original document";
    const send = (title: string, key: string, to: string[]) =>
      command([
        "send",
        "--as-user",
        "--title",
        title,
        "--body",
        sentBody,
        "--idempotency-key",
        key,
        ...to.flatMap((slug) => ["--to", slug]),
      ]);
    const create = send("CLI Create", "create", ["alpha"]);
    const fanout = send("CLI Fanout", "fanout", ["alpha", "beta"]);
    const uploadFile = writeDocument(testHome, "upload.md", "uploaded document");
    const upload = command([
      "send",
      "--as-user",
      "--title",
      "CLI Upload",
      "--file",
      uploadFile,
      "--to",
      "alpha",
      "--allow-external-source",
      "--idempotency-key",
      "upload",
    ]);
    const reviseId = create.handoffs[0].handoffId as string;
    const reviseFile = writeDocument(testHome, "revise.md", "revised document");
    const revised = command([
      "revise",
      reviseId,
      "--as-user",
      "--file",
      reviseFile,
      "--allow-external-source",
      "--expected-row-version",
      "1",
      "--idempotency-key",
      "revise",
    ]);
    const pendingDeletion = (title: string, key: string): string => {
      const id = send(title, key, ["beta"]).handoffs[0].handoffId as string;
      command(["accept", id, "--expected-revision", "1", "--expected-row-version", "1"], beta);
      command(["delete", "request", id], beta);
      return id;
    };
    const deletionId = pendingDeletion("CLI Deletion", "delete-create");
    const reverseDeletionId = pendingDeletion("HTTP Deletion", "reverse-delete-create");
    const deleted = command([
      "delete",
      "approve",
      deletionId,
      "--as-user",
      "--confirm",
      "--expected-row-version",
      "3",
      "--idempotency-key",
      "deletion",
    ]);
    const backup = command(["backup", "run", "--idempotency-key", "backup"]);
    const fresh = (path: string, key: string, data: unknown) => ({
      path,
      key,
      method: "POST",
      body: JSON.stringify(data),
      contentType: "application/json",
    });
    const uploadForm = (title = "CLI Upload") => {
      const form = new FormData();
      form.set("title", title);
      form.append("to", "alpha");
      form.set("file", new Blob(["uploaded document"], { type: "text/markdown" }), "upload.md");
      return form;
    };
    const reviseForm = (version = "1", text = "revised document") => {
      const form = new FormData();
      form.set("asUser", "true");
      form.set("expectedRowVersion", version);
      form.set("file", new Blob([text], { type: "text/markdown" }), "revise.md");
      return form;
    };
    const importPath = "/api/v1/handoffs/import-path";
    const execute = async (scenario: {
      path: string;
      key: string;
      status: number;
      body?: string | FormData;
      contentType?: string;
    }) => {
      const response = await fetch(`http://127.0.0.1:${port}${scenario.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          connection: "close",
          "idempotency-key": scenario.key,
          ...(scenario.contentType ? { "content-type": scenario.contentType } : {}),
        },
        body: scenario.body ?? null,
      });
      const envelope = await response.json();
      expect(response.status, `${scenario.path}: ${JSON.stringify(envelope)}`).toBe(scenario.status);
      expect(response.headers.get("x-request-id")).toBe(envelope.meta.requestId);
      return envelope;
    };
    const replay = async () => {
      const cases = [
        {
          ...fresh(importPath, "create", { asUser: true, to: ["alpha"], title: "CLI Create", body: sentBody }),
          status: 201,
          data: { handoffs: create.handoffs },
        },
        {
          ...fresh(importPath, "fanout", { asUser: true, to: ["beta", "alpha"], title: "CLI Fanout", body: sentBody }),
          status: 201,
          data: { handoffs: fanout.handoffs },
        },
        {
          path: "/api/v1/handoffs/upload",
          key: "upload",
          method: "POST",
          body: uploadForm(),
          status: 201,
          data: { handoffs: upload.handoffs },
        },
        {
          path: `/api/v1/handoffs/${reviseId}/revise`,
          key: "revise",
          method: "POST",
          body: reviseForm(),
          status: 200,
          data: { handoffId: reviseId, revision: revised.revision, rowVersion: revised.rowVersion },
        },
        {
          ...fresh(`/api/v1/handoffs/${deletionId}/deletion-approve`, "deletion", {
            asUser: true,
            confirm: true,
            expectedRowVersion: 3,
          }),
          status: 200,
          data: { handoffId: deletionId, deleted: true, rowVersion: deleted.rowVersion },
        },
        { path: "/api/v1/backup/run", key: "backup", method: "POST", status: 200, data: { runId: backup.runId } },
      ];
      const ids: string[] = [];
      for (const scenario of cases) {
        const envelope = await execute(scenario);
        expect(envelope.data).toMatchObject({ ...scenario.data, replayed: true });
        ids.push(envelope.meta.requestId);
      }
      return ids;
    };

    // Use fresh connections so this exercise observes the new daemon after each restart.
    command(["daemon", "start"]);
    const firstRequestIds = await replay();
    command(["daemon", "stop"]);
    command(["daemon", "start"]);
    const secondRequestIds = await replay();
    expect(new Set([...firstRequestIds, ...secondRequestIds]).size).toBe(12);

    const replacement = "HTTP revision bytes";
    const replacementFile = writeDocument(testHome, "replacement.md", replacement);
    const backwards = [
      {
        ...fresh(importPath, "http-create", { asUser: true, to: ["alpha"], title: "HTTP Create", body: sentBody }),
        status: 201,
        run: () => send("HTTP Create", "http-create", ["alpha"]),
      },
      {
        ...fresh(importPath, "http-fanout", {
          asUser: true,
          to: ["beta", "alpha"],
          title: "HTTP Fanout",
          body: sentBody,
        }),
        status: 201,
        run: () => send("HTTP Fanout", "http-fanout", ["alpha", "beta"]),
      },
      {
        path: "/api/v1/handoffs/upload",
        key: "http-upload",
        body: uploadForm("HTTP Upload"),
        status: 201,
        run: () =>
          command([
            "send",
            "--as-user",
            "--title",
            "HTTP Upload",
            "--file",
            uploadFile,
            "--to",
            "alpha",
            "--allow-external-source",
            "--idempotency-key",
            "http-upload",
          ]),
      },
      {
        path: `/api/v1/handoffs/${reviseId}/revise`,
        key: "http-revise",
        body: reviseForm("2", replacement),
        status: 200,
        run: () =>
          command([
            "revise",
            reviseId,
            "--as-user",
            "--file",
            replacementFile,
            "--allow-external-source",
            "--expected-row-version",
            "2",
            "--idempotency-key",
            "http-revise",
          ]),
      },
      {
        ...fresh(`/api/v1/handoffs/${reverseDeletionId}/deletion-approve`, "http-deletion", {
          asUser: true,
          confirm: true,
          expectedRowVersion: 3,
        }),
        status: 200,
        run: () =>
          command([
            "delete",
            "approve",
            reverseDeletionId,
            "--as-user",
            "--confirm",
            "--expected-row-version",
            "3",
            "--idempotency-key",
            "http-deletion",
          ]),
      },
      {
        path: "/api/v1/backup/run",
        key: "http-backup",
        status: 200,
        run: () => command(["backup", "run", "--idempotency-key", "http-backup"]),
      },
    ];
    const recorded = [];
    for (const scenario of backwards) {
      const { data } = await execute(scenario);
      expect(data.replayed).not.toBe(true);
      recorded.push({ data, run: scenario.run });
    }
    command(["daemon", "stop"]);
    for (const { data, run } of recorded) {
      expect(run()).toEqual({ ...data, replayed: true });
    }
  });
});
