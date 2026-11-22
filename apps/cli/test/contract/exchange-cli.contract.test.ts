import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sorage-exchange-dtos-")));
    const home = join(root, "home");
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    const output: Record<string, unknown> = {};
    for (const cwd of [alpha, beta]) mkdirSync(cwd);
    function run(args: string[], cwd = alpha, installation = home) {
      return spawnSync("bun", [cli, ...args, "--json"], {
        encoding: "utf8",
        cwd,
        env: { ...process.env, SORAGE_HOME: installation, SORAGE_TEST_REQUEST_ID: requestId },
      });
    }
    function success(name: string, args: string[], cwd = alpha, installation = home) {
      const result = run(args, cwd, installation);
      expect(result.status, result.stderr).toBe(0);
      const envelope = JSON.parse(result.stdout);
      if (name) output[name] = envelope;
      return envelope.data;
    }
    function failure(name: string, args: string[], exit: number, cwd = alpha, installation = home) {
      const result = run(args, cwd, installation);
      expect(result.status, result.stderr).toBe(exit);
      expect(result.stdout).toBe("");
      output[name] = JSON.parse(result.stderr);
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
      const history = success("history", ["exchange", "history", id, "--limit", "2"]);
      expect(JSON.parse(Buffer.from(history.cursor, "base64url").toString())).toMatchObject({
        version: 1,
        exchangeId: id,
        seq: 2,
      });
      const delivered = success("historyContinuation", ["exchange", "history", id, "--history-cursor", history.cursor]);
      success("waitQuiet", [
        "exchange",
        "wait",
        id,
        "--history-cursor",
        delivered.cursor,
        "--timeout",
        "1",
        "--interval",
        "1",
      ]);
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
      success("renew", ["exchange", "renew", id, "--claim", String(worker.claimId)], beta);
      success("release", ["exchange", "release", id, "--claim", String(worker.claimId)], beta);

      const writable = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      try {
        writable.exec("DROP TRIGGER abort_activation");
      } finally {
        writable.close();
      }
      const lifecycle = success("", [...creation.slice(0, -1), "lifecycle-create"]);
      const lifecycleId = String(lifecycle.exchangeId);
      function operation(command: string, id: string): string[] {
        return ["exchange", command, lifecycleId, "--operation-id", id];
      }
      function inspect() {
        return success("", ["exchange", "inspect", lifecycleId]);
      }
      const initialClaim = String(success("", ["exchange", "join", lifecycleId]).claimId);
      const original = join(alpha, "original.txt");
      writeFileSync(original, "Retained reference");
      const live = success("", [
        ...operation("material-register", "live"),
        "--claim",
        initialClaim,
        "--kind",
        "live",
        "--source",
        original,
      ]);
      const request = success("", [
        ...operation("request", "request"),
        "--claim",
        initialClaim,
        "--assignee",
        "beta",
        "--condition",
        "Check the file",
        "--criterion",
        "Return a brief result",
      ]);
      const body = success("", [...operation("send", "work"), "--claim", initialClaim, "--file", large]);
      const materialRead = (materialId: string) => [
        "exchange",
        "material-read",
        lifecycleId,
        materialId,
        "--offset",
        "0",
        "--limit",
        "1",
      ];
      const pause = success("pause", [
        ...operation("pause", "pause"),
        "--claim",
        initialClaim,
        "--reason",
        "Wait for a decision",
        "--question",
        "May verification proceed?",
      ]);
      success("pausedJoin", ["exchange", "join", lifecycleId]);
      const pauseFlags = ["--pause-version", String(pause.pauseVersion), "--confirm"];
      const roster = success("roster", [
        ...operation("roster", "remove"),
        ...pauseFlags,
        "--roster-version",
        "1",
        "--remove",
        "beta",
        "--reason",
        "Work was redirected",
      ]);
      const correction = [
        ...operation("owner-correct", "correct"),
        ...pauseFlags,
        "--roster-version",
        String(roster.rosterVersion),
        "--request",
        String(request.requestId),
        "--assignee",
        "alpha",
        "--reason",
        "Fill the vacant assignment",
        "--ownership-version",
      ];
      failure("staleOwnerCorrection", [...correction, "1"], 75);
      failure("occupiedAcceptanceOwner", [...correction, "2", "--acceptance-owner", "alpha"], 64);
      const owner = success("ownerCorrect", [...correction, "2"]);
      const restored = join(root, "restored");
      const rebound = join(root, "rebound-alpha");
      mkdirSync(rebound);
      success("", ["backup", "run", "--as-user"]);
      success("", ["init", "--non-interactive"], rebound, restored);
      success("", ["backup", "restore", "--from", join(home, "vault"), "--as-user", "--confirm"], rebound, restored);
      success("", ["project", "bind", "alpha", "--dir", rebound, "--as-user"], rebound, restored);
      failure("omittedMaterial", materialRead(String(body.materialId)), 66, rebound, restored);
      failure("materialNeedsRevalidation", materialRead(String(live.materialId)), 66, rebound, restored);
      const resume = [...operation("join", "resume"), ...pauseFlags, "--decision", "Proceed with the checked source"];
      const resumed = success("resumedJoin", resume);
      success("resumeReplay", [...resume, "--replay-only"]);
      const activeClaim = String(resumed.claimId);
      const staleReport = run([
        ...operation("report", "stale-assignment"),
        "--claim",
        activeClaim,
        "--request",
        String(request.requestId),
        "--assignment-version",
        String(request.assignmentVersion),
        "--body",
        "Observed the material.",
      ]);
      expect(staleReport.status, staleReport.stderr).toBe(75);
      expect(staleReport.stdout).toBe("");
      expect(JSON.parse(staleReport.stderr)).toEqual({
        ok: false,
        error: {
          code: "ROW_VERSION_CONFLICT",
          message: "The request assignment version changed.",
          details: {},
          recovery: {
            suggestedCommand:
              "Run sorage exchange inspect <exchange-id> --json or call exchange_inspect. Check the effective assignee and assignment version in ownership when present. Report only as the current assignee with a live claim. If the outcome is uncertain, use replay-only with the original operation ID and inputs.",
          },
        },
        meta: { requestId },
      });
      expect(success("", operation("recover", "stale-assignment")).operations).toEqual([]);
      success("materialRevalidate", [
        "exchange",
        "material-revalidate",
        lifecycleId,
        String(live.materialId),
        "--claim",
        activeClaim,
        "--operation-id",
        "revalidate",
        "--source",
        original,
      ]);
      const disposition = success("requestDisposition", [
        ...operation("request-disposition", "cancel"),
        "--claim",
        activeClaim,
        "--request",
        String(request.requestId),
        "--ownership-version",
        String(owner.ownershipVersion),
        "--disposition",
        "cancel",
        "--reason",
        "No work remains",
      ]);
      const stop = success("stop", [
        ...operation("stop", "stop"),
        "--confirm",
        "--pause-version",
        String(pause.pauseVersion),
        "--roster-version",
        String(roster.rosterVersion),
        "--reason",
        "Pause before final approval",
      ]);
      const newClaim = String(
        success("", [...operation("join", "resume-stop"), "--confirm", "--pause-version", String(stop.pauseVersion)])
          .claimId,
      );
      const head = inspect();
      const proposal = [
        ...operation("propose", "propose"),
        "--claim",
        newClaim,
        "--roster-version",
        String(head.rosterVersion),
        "--work-revision",
        String(head.workRevision),
        "--criterion",
        "Observe all rows",
        "--summary",
        "Checked coverage",
      ];
      failure("invalidProposalReport", [...proposal, "--report", "invalid"], 64);
      failure("invalidProposalDisposition", [...proposal, "--disposition", "invalid"], 64);
      const proposed = success("propose", [
        ...proposal,
        "--disposition",
        `${request.requestId}:${disposition.ownershipVersion}`,
      ]);
      const state = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
      let managed: string;
      try {
        const record = state
          .prepare(
            "SELECT storage_key FROM exchange_working_content c JOIN exchange_materials m ON c.id = m.content_id WHERE m.id = ?",
          )
          .get(String(body.materialId)) as { storage_key: string };
        managed = join(home, "state", "exchange-working", record.storage_key);
      } finally {
        state.close();
      }
      const originalBody = readFileSync(managed);
      writeFileSync(managed, "Wrong fixture bytes");
      const vote = [...operation("vote", "vote"), "--claim", newClaim, "--vote", "approve", "--proposal-version"];
      failure("staleProposalVote", [...vote, String(Number(proposed.proposalVersion) + 1)], 75);
      success("voteWithCleanupWarning", [...vote, String(proposed.proposalVersion)]);
      success("completedJoin", ["exchange", "join", lifecycleId]);
      failure("retiredMaterial", materialRead(String(body.materialId)), 66);
      writeFileSync(managed, originalBody);
      success("cleanup", ["exchange", "cleanup", lifecycleId]);

      const reportingExchange = success("", [...creation.slice(0, -1), "notice-create"]);
      const reportingId = String(reportingExchange.exchangeId);
      const reporter = String(success("", ["exchange", "join", reportingId]).claimId);
      const waiting = success("", [
        "exchange",
        "request",
        reportingId,
        "--operation-id",
        "notice-request",
        "--claim",
        reporter,
        "--assignee",
        "beta",
        "--condition",
        "Observe the result",
        "--criterion",
        "Check the reply",
      ]);
      const noticeFixture = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      try {
        noticeFixture
          .prepare("UPDATE exchange_messages SET created_at = ? WHERE exchange_id = ? AND seq = ?")
          .run(new Date(Date.now() - 301_000).toISOString(), reportingId, Number(waiting.seq));
      } finally {
        noticeFixture.close();
      }
      const listing = success("noticeList", ["exchange", "notice-list", reportingId, "--claim", reporter]);
      const incident = String(listing.notices[0].incidentId);
      const slot = success("noticeAcquire", [
        "exchange",
        "notice-acquire",
        reportingId,
        "--incident",
        incident,
        "--claim",
        reporter,
      ]);
      const ack = ["exchange", "notice-ack", reportingId, "--incident", incident, "--operation-id", "notice-issued"];
      failure("noticeAckMissingSlot", [...ack, "--claim", reporter], 75);
      success("noticeAck", [...ack, "--claim", reporter, "--reporting-claim", String(slot.reportingClaimId)]);
      success("noticeAckReplay", [...ack, "--replay-only"]);
      success("noticesAfterAck", ["exchange", "notice-list", reportingId]);

      const normalized = JSON.stringify(output, null, 2)
        .replace(/"cursor": "[A-Za-z0-9_-]+"/g, '"cursor": "<history-cursor>"')
        .replace(/"incidentId": "[a-f0-9]{64}"/g, '"incidentId": "<notice-incident>"')
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
