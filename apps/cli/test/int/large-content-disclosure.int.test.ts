import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appError, errorSpec } from "@sorage/core";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { runCli } from "../../src/main";
import { memoCliFixture } from "../fixtures/memo-cli";

// Faults occur only after real domain commits, or in the optional diagnostic
// formatter. The actual CLI, envelope renderer, SQL and body storage still run.
const fault = vi.hoisted(() => ({ memo: false, send: false, revise: false, format: false }));
vi.mock("@sorage/core", async (original) => {
  const actual = await original<typeof import("@sorage/core")>();
  return {
    ...actual,
    largeContentDisclosureMessage: (...args: Parameters<typeof actual.largeContentDisclosureMessage>) => {
      if (fault.format) throw new Error("Injected diagnostic formatter failure");
      return actual.largeContentDisclosureMessage(...args);
    },
  };
});
vi.mock("@sorage/adapters/src/memo-command-ports", async (original) => {
  const actual = await original<typeof import("@sorage/adapters/src/memo-command-ports")>();
  return {
    ...actual,
    createNodeMemoPorts: (...args: Parameters<typeof actual.createNodeMemoPorts>) => {
      const ports = actual.createNodeMemoPorts(...args);
      if (fault.memo) ports.staging.activateContent = () => ({ ok: true, value: { status: "paused" } });
      return ports;
    },
  };
});
vi.mock("@sorage/adapters/src/handoff-command-ports", async (original) => {
  const actual = await original<typeof import("@sorage/adapters/src/handoff-command-ports")>();
  return {
    ...actual,
    createNodeSendPorts: (...args: Parameters<typeof actual.createNodeSendPorts>) => {
      const ports = actual.createNodeSendPorts(...args);
      if (fault.send)
        ports.handoffs.completeActivations = () => ({
          ok: false,
          error: appError("STORAGE_INTEGRITY_ERROR", "Injected post-commit completion refusal"),
        });
      return ports;
    },
    createNodeRevisionPorts: (...args: Parameters<typeof actual.createNodeRevisionPorts>) => {
      const ports = actual.createNodeRevisionPorts(...args);
      if (fault.revise)
        ports.revisions.completeActivations = () => ({
          ok: false,
          error: appError("STORAGE_INTEGRITY_ERROR", "Injected post-commit completion refusal"),
        });
      return ports;
    },
  };
});
const fixtures: ReturnType<typeof memoCliFixture>[] = [];
const previous = process.env.SORAGE_HOME;
afterEach(() => {
  Object.assign(fault, { memo: false, send: false, revise: false, format: false });
  for (const f of fixtures.splice(0).reverse()) f.cleanup();
  if (previous === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = previous;
});
function fixture() {
  const f = memoCliFixture();
  fixtures.push(f);
  process.env.SORAGE_HOME = f.home;
  configure(true, 70000);
  return f;
}
function configure(enabled: boolean, threshold: number) {
  const store = createNodeConfigCommandPorts().store;
  const read = store.read();
  if (!read.ok || read.value === null) throw new Error("Missing temporary config");
  const written = store.write(
    {
      ...read.value.config,
      gitBackup: { ...read.value.config.gitBackup, enabled, largeArtifactWarningBytes: threshold },
    },
    { etag: read.value.etag },
  );
  if (!written.ok) throw new Error(written.error.message);
}
function call(args: string[], throwingDiagnostic = false) {
  let stdout = "",
    stderr = "";
  const status = runCli(args, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      if (throwingDiagnostic && text.startsWith("The accepted body"))
        throw new Error("Injected diagnostic sink failure");
      stderr += text;
    },
  });
  return { status, stdout, stderr };
}
const body = "x".repeat(70010);
const memoArgs = (title: string, key = randomUUID()) => [
  "memo",
  "add",
  "--project",
  "memo",
  "--title",
  title,
  "--body",
  body,
  "--idempotency-key",
  key,
];
const sendArgs = (key = randomUUID()) => [
  "send",
  "--as",
  "memo",
  "--to",
  "other",
  "--title",
  "Risk",
  "--body",
  body,
  "--idempotency-key",
  key,
];
function success(result: ReturnType<typeof call>) {
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(Object.keys(parsed.data)).not.toContain("warning");
  expect(result.stderr.match(/every committed revision/g)).toHaveLength(1);
  return parsed.data;
}

describe("large-content disclosure through the real CLI", () => {
  it("keeps success JSON separate, resets each invocation, and excludes replay/title-only/no-op", () => {
    fixture();
    const key = randomUUID();
    const created = success(call([...memoArgs("Original", key), "--json"]));
    const replay = call([...memoArgs("Original", key), "--replay-only", "--json"]);
    expect(JSON.parse(replay.stdout).data.replayed).toBe(true);
    expect(replay.stderr).toBe("");
    const show = call(["memo", "show", created.memo.id, "--json"]);
    expect(JSON.parse(show.stdout).data.body).toBe(body);
    expect(show.stderr).toBe("");
    const title = call([
      "memo",
      "update",
      created.memo.id,
      "--title",
      "Renamed",
      "--expected-row-version",
      "1",
      "--json",
    ]);
    expect(title.status).toBe(0);
    expect(title.stderr).toBe("");
    const noop = call(["memo", "update", created.memo.id, "--body", body, "--expected-row-version", "2", "--json"]);
    expect(JSON.parse(noop.stdout).data.changed).toBe(false);
    expect(noop.stderr).toBe("");
    configure(true, 70010);
    expect(call([...memoArgs("Equal"), "--json"]).stderr).toBe("");
    configure(false, 1);
    expect(call([...memoArgs("Disabled"), "--json"]).stderr).toBe("");
  });

  it("keeps post-commit Memo errors as one whole stderr JSON and preserves recovery and the committed body", () => {
    const f = fixture();
    fault.memo = true;
    const result = call([...memoArgs("Pending"), "--json"]);
    expect(result.stdout).toBe("");
    expect(result.status).toBe(errorSpec("CONTENT_MATERIALIZING").exitCode);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe("CONTENT_MATERIALIZING");
    expect(envelope.error.message).toContain("every committed revision");
    expect(envelope.error.recovery).toBeDefined();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_memos").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pending_fs_ops").get()).toEqual({ n: 1 });
  });

  it("does not let diagnostic formatter or sink failures suppress success or the actual error renderer", () => {
    fixture();
    expect(call([...memoArgs("Throwing sink"), "--json"], true).status).toBe(0);
    fault.format = true;
    const successful = call([...memoArgs("Throwing formatter"), "--json"]);
    expect(successful.status).toBe(0);
    expect(JSON.parse(successful.stdout).ok).toBe(true);
    expect(successful.stderr).toBe("");
    fault.memo = true;
    const refused = call([...memoArgs("Pending formatter failure"), "--json"]);
    expect(refused.stdout).toBe("");
    expect(refused.status).toBe(errorSpec("CONTENT_MATERIALIZING").exitCode);
    expect(JSON.parse(refused.stderr).error.code).toBe("CONTENT_MATERIALIZING");
    expect(refused.stderr).not.toContain("every committed revision");
  });

  it("discloses in human output and wires send/revise without changing their success envelopes", () => {
    const f = fixture();
    const human = call(memoArgs("Human"));
    expect(human.status).toBe(0);
    expect(human.stdout).not.toBe("");
    expect(human.stderr).toContain("every committed revision");
    const key = randomUUID();
    const sent = success(call([...sendArgs(key), "--json"]));
    const replay = call([...sendArgs(key), "--json"]);
    expect(JSON.parse(replay.stdout).data.replayed).toBe(true);
    expect(replay.stderr).toBe("");
    const path = join(f.home, "replacement.md");
    writeFileSync(path, "y".repeat(70020));
    success(
      call([
        "revise",
        sent.handoffs[0].handoffId,
        "--as",
        "memo",
        "--expected-row-version",
        "1",
        "--file",
        path,
        "--allow-external-source",
        "--json",
      ]),
    );
  });

  it.each(["send", "revise"] as const)(
    "discloses a late %s completion failure beside the committed success (SHR-015 category (i))",
    (operation) => {
      const f = fixture();
      let args: string[];
      if (operation === "send") {
        fault.send = true;
        args = sendArgs();
      } else {
        const original = success(call([...sendArgs(), "--json"]));
        const path = join(f.home, "replacement.md");
        writeFileSync(path, "z".repeat(70020));
        fault.revise = true;
        args = [
          "revise",
          original.handoffs[0].handoffId,
          "--as",
          "memo",
          "--expected-row-version",
          "1",
          "--file",
          path,
          "--allow-external-source",
        ];
      }
      const result = call([...args, "--json"]);
      // The committed outcome is returned as the success it already is; the
      // physical completion failure and the large-content disclosure are both
      // disclosed on stderr, and no error envelope replaces the result.
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(result.stderr).not.toContain('"ok"');
      expect(result.stderr).toContain("Injected post-commit completion refusal");
      expect(result.stderr).toContain("every committed revision");
      if (operation === "send") {
        expect(parsed.data.handoffs).toHaveLength(1);
      } else {
        expect(typeof parsed.data.revision).toBe("number");
      }
    },
  );
});
