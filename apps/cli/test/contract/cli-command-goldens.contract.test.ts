import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The TASK-036 golden tour: every command in the M1 catalog runs as a real process
 * against one initialized temporary installation and its normalized `--json` envelope
 * is pinned byte-for-byte. The contract under test is the envelope shape, so the
 * harness applies one documented, order-fixed normalization before comparing:
 * the temporary home path becomes `<home>`, the `artifacts/<handoff>/<artifact>/` key
 * segment becomes `artifacts/<uuid>/<key>/`, every UUID becomes `<uuid>`, every
 * ISO-8601 instant becomes `<ts>`, and every 64-hex digest becomes `<digest>`;
 * small integers such as revisions, row versions, and counts stay literal because
 * the tour's sequence makes them deterministic, every 64-hex digest becomes
 * `<digest>`, and every 40-hex Git object id becomes `<sha>`. Refresh the goldens
 * by running the suite once with SORAGE_UPDATE_GOLDENS=1 and reviewing the diff.
 */
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const goldenDir = fileURLToPath(new URL("./golden/tour/", import.meta.url));
const updateGoldens = process.env.SORAGE_UPDATE_GOLDENS === "1";

const home = mkdtempSync(join(tmpdir(), "sorage-golden-tour-"));
const workA = join(home, "work-a");
const workB = join(home, "work-b");
const workA2 = join(home, "work-a-2");
const replacement = join(home, "replacement.md");
mkdirSync(workA, { recursive: true });
mkdirSync(workB, { recursive: true });
mkdirSync(workA2, { recursive: true });
writeFileSync(replacement, "# The golden brief, revised\n");
afterAll(() => {
  if (!updateGoldens) rmSync(home, { recursive: true, force: true });
});

const handoffIds = new Map<string, string>();
let tourPort = 0;

beforeAll(async () => {
  tourPort = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
});

function normalize(text: string): string {
  return (
    text
      .split(home)
      .join("<home>")
      .split("/private<home>")
      .join("<home>")
      // The tour uses an available port so an installed Sorage daemon cannot
      // affect doctor; normalize it back to the documented default in goldens.
      .split(String(tourPort))
      .join("46321")
      .replace(
        /artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]+\//g,
        "artifacts/<uuid>/<key>/",
      )
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>")
      .replace(/\b[0-9a-f]{64}\b/g, "<digest>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      // The Git repository's byte count shifts between runs of identical content
      // (object mtimes and index bytes), so the golden pins the field, not the size.
      .replace(/"repositorySizeBytes": \d+/g, '"repositorySizeBytes": <bytes>')
  );
}

function runTour(
  args: string[],
  cwd: string = workA,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const resolved = args.map((arg) => {
    if (arg === "{PORT}") return String(tourPort);
    return arg.startsWith("{") && arg.endsWith("}") ? (handoffIds.get(arg.slice(1, -1)) ?? arg) : arg;
  });
  const result = spawnSync("bun", [entry, ...resolved], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      HOME: home,
      SORAGE_TEST_REQUEST_ID: "2f0ac9a0-0000-4000-8000-0000000000aa",
      SORAGE_HOME: home,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface Step {
  name: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  expectedStatus?: number;
  capture?: string;
}

const steps: Step[] = [
  { name: "01-init", args: ["init", "--non-interactive", "--port", "{PORT}", "--json"] },
  { name: "02-config-show", args: ["config", "show", "--json"] },
  { name: "03-config-validate", args: ["config", "validate", "--json"] },
  { name: "04-config-set", args: ["config", "set", "ui.defaultPageSize", "25", "--as-user", "--json"] },
  { name: "05-config-edit", args: ["config", "edit", "--as-user", "--json"], env: { EDITOR: "true" } },
  { name: "06-doctor", args: ["doctor", "--json"] },
  { name: "07-project-add-alpha", args: ["project", "add", "--name", "Alpha", "--dir", workA, "--json"] },
  { name: "08-project-add-beta", args: ["project", "add", "--name", "Beta", "--dir", workB, "--json"] },
  { name: "09-project-list", args: ["project", "list", "--json"] },
  { name: "10-project-show", args: ["project", "show", "alpha", "--json"] },
  { name: "11-project-rename", args: ["project", "rename", "alpha", "--name", "Alpha Prime", "--json"] },
  { name: "12-project-bind", args: ["project", "bind", "alpha", "--dir", workA2, "--json"] },
  { name: "13-project-resolve", args: ["project", "resolve", "--path", workA, "--json"] },
  { name: "14-project-unbind", args: ["project", "unbind", "alpha", "--dir", workA2, "--json"] },
  {
    name: "15-send-h1",
    args: [
      "send",
      "--as",
      "alpha",
      "--to",
      "beta",
      "--title",
      "Golden brief",
      "--body",
      "# The golden brief",
      "--json",
    ],
    capture: "H1",
  },
  { name: "16-inbox", args: ["inbox", "--as", "beta", "--json"], cwd: workB },
  { name: "17-get", args: ["get", "{H1}", "--as", "beta", "--json"], cwd: workB },
  { name: "18-fetch", args: ["fetch", "{H1}", "--as", "beta", "--json"], cwd: workB },
  {
    name: "19-review-set",
    args: ["review", "set", "{H1}", "--as", "beta", "--text", "Tighten the title", "--json"],
    cwd: workB,
  },
  { name: "20-review-withdraw", args: ["review", "withdraw", "{H1}", "--as", "beta", "--json"], cwd: workB },
  {
    name: "21-review-set-again",
    args: ["review", "set", "{H1}", "--as", "beta", "--text", "Tighten the title again", "--json"],
    cwd: workB,
  },
  { name: "21a-review-show", args: ["review", "show", "{H1}", "--as", "beta", "--json"], cwd: workB },
  { name: "21b-review-show-sender", args: ["review", "show", "{H1}", "--as", "alpha", "--json"] },
  { name: "21c-events", args: ["events", "{H1}", "--as", "alpha", "--json"] },
  {
    name: "22-revise",
    args: ["revise", "{H1}", "--as", "alpha", "--file", replacement, "--allow-external-source", "--json"],
  },
  {
    name: "23-accept",
    args: ["accept", "{H1}", "--as", "beta", "--expected-revision", "2", "--expected-row-version", "5", "--json"],
    cwd: workB,
  },
  { name: "24-pin", args: ["pin", "{H1}", "--as-user", "--json"] },
  { name: "25-unpin", args: ["unpin", "{H1}", "--as-user", "--json"] },
  { name: "26-archive", args: ["archive", "{H1}", "--as-user", "--json"] },
  { name: "27-unarchive", args: ["unarchive", "{H1}", "--as-user", "--json"] },
  {
    name: "28-inbox-wait-timeout",
    args: ["inbox", "--as", "beta", "--wait", "--timeout", "1", "--interval", "1", "--json"],
    cwd: workB,
  },
  {
    name: "29-send-h2",
    args: ["send", "--as", "alpha", "--to", "beta", "--title", "Note removal case", "--body", "# Two", "--json"],
    capture: "H2",
  },
  {
    name: "30-review-set-h2",
    args: ["review", "set", "{H2}", "--as", "beta", "--text", "Remove me", "--json"],
    cwd: workB,
  },
  { name: "31-review-remove", args: ["review", "remove", "{H2}", "--as-user", "--confirm", "--json"] },
  { name: "31a-review-show-null", args: ["review", "show", "{H2}", "--as", "beta", "--json"], cwd: workB },
  {
    name: "32-send-h3",
    args: ["send", "--as", "alpha", "--to", "beta", "--title", "Decline case", "--body", "# Three", "--json"],
    capture: "H3",
  },
  {
    name: "33-decline",
    args: ["decline", "{H3}", "--as", "beta", "--reason", "Not applicable", "--expected-row-version", "1", "--json"],
    cwd: workB,
  },
  {
    name: "34-send-h4",
    args: ["send", "--as", "alpha", "--to", "beta", "--title", "Withdraw case", "--body", "# Four", "--json"],
    capture: "H4",
  },
  { name: "35-withdraw", args: ["withdraw", "{H4}", "--as", "alpha", "--json"] },
  {
    name: "36-send-h5",
    args: ["send", "--as", "alpha", "--to", "beta", "--title", "Deletion approve case", "--body", "# Five", "--json"],
    capture: "H5",
  },
  {
    name: "37-accept-h5",
    args: ["accept", "{H5}", "--as", "beta", "--expected-revision", "1", "--expected-row-version", "1", "--json"],
    cwd: workB,
  },
  { name: "38-delete-request", args: ["delete", "request", "{H5}", "--as", "beta", "--json"], cwd: workB },
  { name: "39-delete-approve", args: ["delete", "approve", "{H5}", "--as-user", "--confirm", "--json"] },
  { name: "39a-events-tombstone", args: ["events", "{H5}", "--as", "beta", "--json"], cwd: workB },
  { name: "39b-review-show-tombstone", args: ["review", "show", "{H5}", "--as", "beta", "--json"], cwd: workB },
  {
    name: "40-send-h6",
    args: ["send", "--as", "alpha", "--to", "beta", "--title", "Deletion reject case", "--body", "# Six", "--json"],
    capture: "H6",
  },
  {
    name: "41-accept-h6",
    args: ["accept", "{H6}", "--as", "beta", "--expected-revision", "1", "--expected-row-version", "1", "--json"],
    cwd: workB,
  },
  { name: "42-delete-request-h6", args: ["delete", "request", "{H6}", "--as", "beta", "--json"], cwd: workB },
  { name: "43-delete-reject", args: ["delete", "reject", "{H6}", "--as-user", "--json"] },
  { name: "44-vault-status", args: ["vault", "status", "--json"] },
  { name: "45-vault-verify", args: ["vault", "verify", "--json"] },
  { name: "46-vault-move", args: ["vault", "move", "--to", join(home, "moved-vault"), "--as-user", "--json"] },
  { name: "47-vault-status-moved", args: ["vault", "status", "--json"] },
  { name: "48-project-archive", args: ["project", "archive", "alpha", "--json"] },
  { name: "49-project-unarchive", args: ["project", "unarchive", "alpha", "--json"] },
  {
    name: "50-backup-verify-no-git",
    args: ["backup", "verify", "--json"],
    expectedStatus: 1,
  },
  {
    name: "51-backup-run",
    args: ["backup", "run", "--idempotency-key", "2f0ac9a0-0000-4000-8000-0000000000bb", "--json"],
  },
  {
    name: "52-backup-run-replay",
    args: ["backup", "run", "--idempotency-key", "2f0ac9a0-0000-4000-8000-0000000000bb", "--json"],
  },
  { name: "53-backup-run-again", args: ["backup", "run", "--json"] },
  { name: "54-backup-status", args: ["backup", "status", "--json"] },
  {
    name: "55-backup-enable-requires-user",
    args: ["backup", "enable", "--daily-at", "03:00"],
    expectedStatus: 77,
  },
  {
    name: "56-backup-enable",
    args: ["backup", "enable", "--daily-at", "04:05", "--timezone", "UTC", "--as-user", "--json"],
  },
  {
    name: "57-backup-enable-push-requires-user",
    args: ["backup", "enable-push", "--remote", "origin", "--branch", "main"],
    expectedStatus: 77,
  },
  {
    name: "58-backup-enable-push",
    args: ["backup", "enable-push", "--remote", "origin", "--branch", "main", "--as-user", "--json"],
  },
  { name: "59-backup-disable-push", args: ["backup", "disable-push", "--as-user", "--json"] },
  { name: "60-backup-disable", args: ["backup", "disable", "--as-user", "--json"] },
  { name: "61-project-rebind", args: ["project", "rebind", "alpha", "--from", workA, "--to", workA2, "--json"] },
];

describe("the golden tour of every catalog command", () => {
  it("pins every command's normalized JSON envelope", () => {
    for (const step of steps) {
      const run = runTour(step.args, step.cwd ?? workA, step.env);
      expect(run.status, `${step.name} exit`).toBe(step.expectedStatus ?? 0);
      const normalizedOut = normalize(run.stdout);
      if (step.capture !== undefined) {
        const envelope = JSON.parse(run.stdout) as { data: { handoffs: Array<{ handoffId: string }> } };
        const id = envelope.data.handoffs[0]?.handoffId;
        expect(id, `${step.name} captured its Handoff id`).toBeTruthy();
        handoffIds.set(step.capture, id as string);
      }
      const goldenPath = `${goldenDir}${step.name}.json`;
      if (updateGoldens) {
        mkdirSync(goldenDir, { recursive: true });
        writeFileSync(goldenPath, normalizedOut);
        continue;
      }
      const golden = readFileSync(goldenPath, "utf8");
      expect(normalizedOut, `${step.name} stdout`).toBe(normalize(golden));
    }
    // The tour spawns Bun for every catalog command; allow scheduling headroom
    // on a busy machine without changing any per-command contract assertion.
  }, 90_000);
});
