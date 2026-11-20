import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const exchangeId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

describe("Exchange CLI JSON and read error boundary", () => {
  it("renders typed log-free read input and admission errors, and leaves parser errors log-free", () => {
    const root = mkdtempSync(join(tmpdir(), "sorage-exchange-cli-contract-"));
    const home = join(root, "missing");
    function run(args: string[]) {
      return spawnSync("bun", [cli, ...args], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: requestId },
      });
    }
    try {
      const material = run([
        "exchange",
        "material-read",
        exchangeId,
        exchangeId,
        "--offset",
        "invalid",
        "--limit",
        "1",
        "--json",
      ]);
      expect(material.status).toBe(64);
      expect(material.stdout).toBe("");
      expect(JSON.parse(material.stderr)).toEqual({
        ok: false,
        error: {
          code: "EXCHANGE_INVALID_INPUT",
          message: "Material offset must be a non-negative safe integer.",
          details: {},
          recovery: { suggestedCommand: "Check the Exchange operands and recorded limits" },
        },
        meta: { requestId },
      });
      const missing = run(["--json", "exchange", "inspect", exchangeId]);
      expect(missing.status).toBe(78);
      expect(JSON.parse(missing.stderr)).toMatchObject({
        ok: false,
        error: { code: "NOT_INITIALIZED" },
        meta: { requestId },
      });
      const malformed = run(["exchange", "history", exchangeId, "--limit", "absent", "--json"]);
      expect(malformed.status).toBe(2);
      for (const flags of [["--cursor", "irrelevant"], ["--expected-row-version", "1"], ["--confirm"]]) {
        const unsupported = run(["exchange", "history", exchangeId, "--json", ...flags]);
        expect(unsupported.status).toBe(64);
        expect(JSON.parse(unsupported.stderr).error.code).toBe("EXCHANGE_INVALID_INPUT");
      }
      const replay = run(["exchange", "send", exchangeId, "--replay-only", "--body", "original", "--json"]);
      expect(replay.status).toBe(2);
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the closed DTOs of every Exchange command and the pending recovery result", () => {
    const root = mkdtempSync(join(tmpdir(), "sorage-exchange-dtos-"));
    const home = join(root, "home");
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    const output: Record<string, unknown> = {};
    for (const cwd of [alpha, beta]) mkdirSync(cwd);
    function run(args: string[], cwd = alpha) {
      return spawnSync("bun", [cli, ...args, "--json"], {
        encoding: "utf8",
        cwd,
        env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: requestId },
      });
    }
    function success(name: string, args: string[], cwd = alpha) {
      const result = run(args, cwd);
      expect(result.status, result.stderr).toBe(0);
      const envelope = JSON.parse(result.stdout);
      if (name) output[name] = envelope;
      return envelope.data;
    }
    try {
      success("", ["init", "--non-interactive"]);
      const project = success("", ["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", alpha]);
      success("", ["project", "add", "--name", "Beta", "--slug", "beta", "--dir", beta]);
      const creation = [
        "exchange",
        "create",
        "--member",
        "beta",
        "--goal",
        "Check coverage",
        "--criterion",
        "Observe all rows",
        "--operation-id",
        "create-1",
      ];
      const created = success("create", creation);
      const id = String(created.exchangeId);
      success("createReplay", [...creation, "--replay-only"]);
      const opener = success("join", [
        "exchange",
        "--project",
        String(project.id ?? project.project?.id),
        "join",
        id,
        "--as",
        "alpha",
      ]);
      const worker = success("", ["exchange", "join", id], beta);
      const send = [
        "exchange",
        "send",
        id,
        "--claim",
        String(opener.claimId),
        "--operation-id",
        "post-1",
        "--to",
        "beta",
        "--body",
        "Start the check",
      ];
      const posted = success("send", send);
      const asked = success("request", [
        "exchange",
        "request",
        id,
        "--claim",
        String(opener.claimId),
        "--operation-id",
        "request-1",
        "--assignee",
        "beta",
        "--condition",
        "Collect both pages",
        "--criterion",
        "Return named evidence",
        "--reply-to",
        String(posted.seq),
      ]);
      const source = join(beta, "evidence");
      writeFileSync(source, "observed");
      const copy = success(
        "materialRegister",
        [
          "exchange",
          "material-register",
          id,
          "--claim",
          String(worker.claimId),
          "--operation-id",
          "copy-1",
          "--kind",
          "copy",
          "--source",
          source,
        ],
        beta,
      );
      success("materialPage", [
        "exchange",
        "material-read",
        id,
        String(copy.materialId),
        "--offset",
        "0",
        "--limit",
        "3",
      ]);
      const external = success(
        "externalRegister",
        [
          "exchange",
          "material-register",
          id,
          "--claim",
          String(worker.claimId),
          "--operation-id",
          "external-1",
          "--kind",
          "external",
          "--access",
          "run-id",
          "--value",
          "checks/qualified-1",
        ],
        beta,
      );
      success("externalReference", [
        "exchange",
        "material-read",
        id,
        String(external.materialId),
        "--offset",
        "0",
        "--limit",
        "1",
      ]);
      const report = success(
        "report",
        [
          "exchange",
          "report",
          id,
          "--claim",
          String(worker.claimId),
          "--operation-id",
          "report-1",
          "--request",
          String(asked.requestId),
          "--assignment-version",
          "1",
          "--body",
          "Both pages observed.",
          "--evidence",
          String(copy.materialId),
        ],
        beta,
      );
      success("accept", [
        "exchange",
        "accept",
        id,
        "--claim",
        String(opener.claimId),
        "--operation-id",
        "accept-1",
        "--accept",
        `${String(report.requestId)}:${String(report.reportVersion)}`,
      ]);
      success("inspect", ["exchange", "inspect", id]);
      success("history", ["exchange", "history", id, "--limit", "2"]);
      const progress = [
        "exchange",
        "confirm-read",
        id,
        "--claim",
        String(opener.claimId),
        "--range",
        "1",
        "--range",
        "3",
      ];
      success("confirmRead", progress);
      success("repeatRead", progress);
      success("recover", ["exchange", "recover", id, "--operation-id", "report-1"], beta);

      const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      try {
        db.exec(
          "CREATE TRIGGER abort_activation BEFORE UPDATE ON exchange_working_content WHEN NEW.materialized = 1 BEGIN SELECT RAISE(ABORT, 'fixture'); END",
        );
      } finally {
        db.close();
      }
      const large = join(alpha, "pending.txt");
      writeFileSync(large, "x".repeat(65_537));
      const queued = success("pendingWarning", [
        "exchange",
        "send",
        id,
        "--claim",
        String(opener.claimId),
        "--operation-id",
        "pending-1",
        "--file",
        large,
      ]);
      const read = run(["exchange", "material-read", id, String(queued.materialId), "--offset", "0", "--limit", "1"]);
      expect(read.status).toBe(75);
      output.pendingRead = JSON.parse(read.stderr);

      const normalized = JSON.stringify(output, null, 2)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
      const golden = fileURLToPath(new URL("./golden/exchange-dtos.json", import.meta.url));
      if (process.env.SORAGE_UPDATE_GOLDENS === "1") writeFileSync(golden, `${normalized}\n`);
      expect(JSON.parse(normalized)).toEqual(JSON.parse(readFileSync(golden, "utf8")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
