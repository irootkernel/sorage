import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BINARY, envelopeOf, errorEnvelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

const executeFile = promisify(execFile);
afterEach(runCleanups);

describe("AJ-34 compiled CLI collaboration and exact recovery", () => {
  it("carries exact bodies and report versions across processes and converges a same-ID race", async () => {
    const parent = realpathSync(makeTempDir("aj34-"));
    const home = join(parent, "home");
    const alpha = join(parent, "alpha");
    const beta = join(parent, "beta");
    const binary = process.env.SORAGE_AJ34_BINARY ?? BINARY;
    mkdirSync(alpha);
    mkdirSync(beta);
    const call = (args: string[], cwd = alpha) => sorage([...args, "--json"], { home, cwd, binary });
    function data(args: string[], cwd = alpha) {
      const run = call(args, cwd);
      expect(run.status, run.stderr || run.stdout).toBe(0);
      return envelopeOf(run).data as Record<string, unknown>;
    }
    data(["init", "--non-interactive"]);
    for (const [slug, cwd] of [
      ["alpha", alpha],
      ["beta", beta],
    ] as const) {
      data(["project", "add", "--name", slug, "--slug", slug, "--dir", cwd]);
    }
    const create = [
      "exchange",
      "create",
      "--member",
      "beta",
      "--goal",
      "Check paging",
      "--criterion",
      "No missing data",
      "--operation-id",
      "lost-create",
    ];
    const created = data(create);
    const id = String(created.exchangeId);
    expect(created).not.toHaveProperty("claimId");
    const discovered = data(["exchange", "recover", "--operation-id", "lost-create"]);
    expect(discovered.operations).toEqual([
      { operationId: "lost-create", outcome: { kind: "create", exchangeId: id } },
    ]);
    expect(data([...create, "--replay-only"])).toEqual({ ...created, replayed: true });

    const alphaClaim = String(data(["exchange", "join", id]).claimId);
    const request = data([
      "exchange",
      "request",
      id,
      "--claim",
      alphaClaim,
      "--assignee",
      "beta",
      "--condition",
      "Deliver measured paging evidence",
      "--criterion",
      "Include the bounded bytes",
      "--operation-id",
      "request-1",
    ]);
    const betaView = data(["exchange", "join", id], beta);
    expect(betaView.requests).toMatchObject([{ id: request.requestId, state: "in-progress" }]);
    const betaClaim = String(betaView.claimId);
    const file = join(beta, "result.txt");
    const bytes = Buffer.from(`\uFEFFACTUAL_PAGING_RESULT_MARKER\r\n${"나".repeat(22_001)}\n`);
    writeFileSync(file, bytes);
    const report = data(
      [
        "exchange",
        "report",
        id,
        "--claim",
        betaClaim,
        "--request",
        String(request.requestId),
        "--assignment-version",
        "1",
        "--operation-id",
        "report-1",
        "--file",
        file,
      ],
      beta,
    );
    const materialId = String(report.materialId);
    const first = data(["exchange", "material-read", id, materialId, "--offset", "0", "--limit", "65536"]);
    const last = data([
      "exchange",
      "material-read",
      id,
      materialId,
      "--offset",
      String(first.nextOffset),
      "--limit",
      "65536",
    ]);
    expect([first.end, last.end]).toEqual([false, true]);
    const checked = Buffer.concat([
      Buffer.from(String(first.bytes), "base64"),
      Buffer.from(String(last.bytes), "base64"),
    ]);
    expect(checked).toEqual(bytes);
    expect(
      data([
        "exchange",
        "accept",
        id,
        "--claim",
        alphaClaim,
        "--accept",
        `${String(request.requestId)}:1`,
        "--operation-id",
        "accept-1",
      ]).sequences,
    ).toEqual([3]);

    const raced = [
      "exchange",
      "send",
      id,
      "--claim",
      alphaClaim,
      "--operation-id",
      "race-1",
      "--body",
      "same operation",
    ];
    const concurrent = () =>
      executeFile(binary, [...raced, "--json"], {
        cwd: alpha,
        env: { ...process.env, SORAGE_HOME: home },
        timeout: 10_000,
      });
    const attempts = await Promise.allSettled([concurrent(), concurrent()]);
    const results = attempts.map((attempt) => {
      if (attempt.status === "fulfilled") {
        return envelopeOf({ status: 0, ...attempt.value }).data as Record<string, unknown>;
      }
      const error: unknown = attempt.reason;
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== 75 ||
        !("stdout" in error) ||
        error.stdout !== "" ||
        !("stderr" in error) ||
        typeof error.stderr !== "string"
      ) {
        throw error;
      }
      const refusal = errorEnvelopeOf({ status: 75, stdout: error.stdout, stderr: error.stderr }).error;
      expect(refusal, error.stderr).toMatchObject({
        code: "STORAGE_INSPECTION_UNAVAILABLE",
        details: { storageContention: true },
      });
      // Both writers have exited. Recover the winning receipt without executing the refused attempt.
      return data([...raced, "--replay-only"]);
    });
    expect(results.map(({ seq }) => seq)).toEqual([4, 4]);
    expect([...new Set(results.map(({ materialId }) => materialId))]).toEqual([expect.any(String)]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(
      data(["exchange", "send", id, "--claim", alphaClaim, "--operation-id", "race-2", "--body", "same operation"]).seq,
    ).toBe(5);
    const replayMiss = call([
      "exchange",
      "send",
      id,
      "--operation-id",
      "unknown",
      "--replay-only",
      "--body",
      "same operation",
    ]);
    expect(replayMiss.status).toBe(75);
    expect(errorEnvelopeOf(replayMiss).error.code).toBe("EXCHANGE_REPLAY_UNAVAILABLE");
    const exactFlagValue = data([
      "exchange",
      "send",
      id,
      "--claim",
      alphaClaim,
      "--operation-id",
      "flag-is-text",
      "--body",
      "--replay-only",
    ]);
    expect(exactFlagValue.replayed).toBe(false);
    expect(data(["exchange", "history", id]).messages).toHaveLength(6);
    expect(
      data(["exchange", "confirm-read", id, "--claim", alphaClaim, "--range", "1", "--range", "3-4"]).readRanges,
    ).toEqual([
      { firstSeq: 1, lastSeq: 1 },
      { firstSeq: 3, lastSeq: 4 },
    ]);
    const contender = call(["exchange", "join", id]);
    expect(contender.status).toBe(75);
    const observation = errorEnvelopeOf(contender).error.details?.observedClaim;
    expect(observation).not.toBe(alphaClaim);
    const successor = String(
      data(["exchange", "join", id, "--replace-claim", String(observation), "--confirm"]).claimId,
    );
    expect(successor).not.toBe(alphaClaim);
    const logs = join(home, "logs", "sorage.log");
    const beforeFailure = existsSync(logs) ? readFileSync(logs, "utf8") : "";
    const refused = call([
      "exchange",
      "send",
      id,
      "--claim",
      alphaClaim,
      "--operation-id",
      "obsolete",
      "--body",
      "old claim",
    ]);
    expect(errorEnvelopeOf(refused).error.code).toBe("EXCHANGE_CLAIM_CONFLICT");
    expect(existsSync(logs) ? readFileSync(logs, "utf8") : "").toBe(beforeFailure);
    const badReply = call([
      "exchange",
      "send",
      id,
      "--claim",
      successor,
      "--operation-id",
      "bad-reply",
      "--reply-to",
      "99999",
      "--body",
      "SYNTHETIC_BODY_DOES_NOT_ENTER_LOGS",
    ]);
    expect(errorEnvelopeOf(badReply).error.code).toBe("EXCHANGE_INVALID_INPUT");
    const log = readFileSync(logs, "utf8");
    expect(log).toContain("An admitted Exchange write returned a failure.");
    expect(log).not.toContain(successor);
    expect(log).not.toContain("SYNTHETIC_BODY_DOES_NOT_ENTER_LOGS");

    const copyFile = join(beta, "copy.bin");
    writeFileSync(copyFile, "ACTUAL_MANAGED_COPY_MARKER");
    const copy = data(
      [
        "exchange",
        "material-register",
        id,
        "--claim",
        betaClaim,
        "--operation-id",
        "copy-1",
        "--kind",
        "copy",
        "--source",
        copyFile,
      ],
      beta,
    );
    const copyRead = data(["exchange", "material-read", id, String(copy.materialId), "--offset", "0", "--limit", "64"]);
    expect(Buffer.from(String(copyRead.bytes), "base64").toString("utf8")).toBe("ACTUAL_MANAGED_COPY_MARKER");
    expect(data(["backup", "run"]).snapshot).toBe("success");
    const vault = join(home, "vault");
    const { stdout: paths } = await executeFile("git", ["-C", vault, "ls-tree", "-r", "--name-only", "-z", "HEAD"]);
    expect(paths).toContain("snapshots/exchanges.json");
    for (const path of paths.split("\0").filter(Boolean)) {
      const disk = readFileSync(join(vault, path));
      const { stdout: tracked } = await executeFile("git", ["-C", vault, "show", `HEAD:${path}`], {
        encoding: "buffer",
      });
      for (const bytes of [disk, tracked]) {
        expect(bytes.includes("ACTUAL_PAGING_RESULT_MARKER")).toBe(false);
        expect(bytes.includes("ACTUAL_MANAGED_COPY_MARKER")).toBe(false);
      }
    }
  }, 25_000);
});
