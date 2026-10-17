import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appError, ERROR_CODES, errorSpec, ok, type SendRecoveryInput } from "@sorage/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";
import { renderSendRecoveryError, runSendRecoveryCommand } from "../../src/send-recovery-command";

const originalHome = process.env.SORAGE_HOME;
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.SORAGE_HOME;
  else process.env.SORAGE_HOME = originalHome;
});
function output() {
  const out: string[] = [],
    err: string[] = [];
  return {
    ports: {
      out: (s: string) => {
        out.push(s);
      },
      err: (s: string) => {
        err.push(s);
      },
    },
    out,
    err,
  };
}
const id = "2f0ac9a0-0000-4000-8000-0000000000aa";
const input: SendRecoveryInput = {
  to: ["beta"],
  title: "Original",
  body: "exact",
  path: "/work",
  userHome: "/home",
  allowExternalSource: false,
  allowUnregistered: false,
  idempotencyKey: "original",
};
describe("send recovery command boundary", () => {
  it.each(ERROR_CODES)("gives %s contextual message and recovery without operational catalogue hints", (code) => {
    const cap = output();
    expect(
      renderSendRecoveryError(appError(code, "use a new key; sorage init; see installation logs"), {
        ...cap,
        json: true,
        requestId: id,
      }),
    ).toBe(errorSpec(code).exitCode);
    expect(cap.out).toEqual([]);
    const body = JSON.parse(cap.err.join(""));
    expect(body.error.code).toBe(code);
    expect(body.error.message).toContain("original send outcome remains unknown");
    for (const text of [body.error.message, body.error.recovery.suggestedCommand]) {
      expect(text).toContain("original key");
      expect(text).toContain("Installation");
      expect(text).toContain("sender context");
      expect(text).toContain(id);
      expect(text).not.toMatch(/new key|sorage (init|send|config)|sorage\.log|--as-user|--confirm/);
    }
  });
  it("retains request ID and output for an unexpected defect without logging", () => {
    const cap = output();
    expect(
      runSendRecoveryCommand({
        ...cap,
        json: false,
        requestId: id,
        input,
        recover: () => {
          throw new Error("unexpected defect");
        },
      }),
    ).toBe(1);
    expect(cap.err.join("")).toContain("INTERNAL_ERROR");
    expect(cap.err.join("")).toContain(id);
    expect(cap.err.join("")).toContain("this output");
    expect(cap.err.join("")).not.toContain("logs/");
  });
  it("labels human success as historical rather than current state or activation", () => {
    const cap = output();
    expect(
      runSendRecoveryCommand({
        ...cap,
        json: false,
        requestId: id,
        input,
        recover: () =>
          ok({
            handoffs: [
              {
                handoffId: "h",
                recipientSlug: "beta",
                artifactId: "a",
                storageKey: "artifacts/h/a/x",
                revision: 1,
                rowVersion: 1,
                reviewState: "awaiting_recipient",
              },
            ],
            dispatchGroupId: null,
            replayed: true,
          }),
      }),
    ).toBe(0);
    expect(cap.out.join("")).toContain("Historical send receipt");
    expect(cap.out.join("")).toContain("does not report current delivery or Artifact activation");
    expect(cap.err).toEqual([]);
  });
  it.each([[], ["--idempotency-key", ""], ["--idempotency-key", "   "]].map((extra) => ({ extra })))(
    "rejects missing/empty original keys before home initialization: %j",
    ({ extra }) => {
      const root = mkdtempSync(join(tmpdir(), "sorage-replay-usage-"));
      roots.push(root);
      process.env.SORAGE_HOME = join(root, "absent");
      const cap = output();
      expect(
        runCli(
          ["send", "--to", "beta", "--title", "Original", "--body", "exact", "--replay-only", ...extra],
          cap.ports,
        ),
      ).toBe(2);
      expect(cap.err.join("")).toContain("original nonempty --idempotency-key");
      expect(existsSync(process.env.SORAGE_HOME)).toBe(false);
    },
  );
});
