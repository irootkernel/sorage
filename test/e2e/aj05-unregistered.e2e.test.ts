import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  errorEnvelopeOf,
  envelopeOf,
  registerCleanup,
  rmSyncSafe,
  runCleanups,
  sorage,
  twoProjectFixture,
} from "./helpers";

/** AJ-05: unregistered Workspace identity, the downgrade guard, and later registration. */
afterAll(runCleanups);

function unboundDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registerCleanup(() => rmSyncSafe(dir));
  return dir;
}

describe("AJ-05 unregistered workspaces", () => {
  it.each([
    { legacy: false, nested: false, format: "sender-aware", registration: "Workspace" },
    { legacy: true, nested: false, format: "legacy", registration: "Workspace" },
    { legacy: false, nested: true, format: "sender-aware", registration: "descendant" },
    { legacy: true, nested: true, format: "legacy", registration: "descendant" },
  ])("replays a $format send after $registration registration", ({ legacy, nested }) => {
    const fixture = twoProjectFixture(`aj05-replay-${legacy}-${nested}`);
    const workspace = unboundDir("aj05-replay-workspace-");
    const key = legacy ? "fe9f5720-ac90-45b1-94cb-17983799b095" : "2540037e-e9c7-47b3-ab48-046713784db2";
    const args = [
      "send",
      "--to",
      "beta",
      "--title",
      "Workspace replay",
      "--body",
      "# Same",
      "--idempotency-key",
      key,
      "--json",
    ];
    const first = sorage(args, { home: fixture.home, cwd: workspace });
    expect(first.status).toBe(0);
    const firstId = (envelopeOf(first) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId;
    if (legacy) {
      const canonical = JSON.stringify({
        kind: "body",
        title: "Workspace replay",
        to: ["beta"],
        content: createHash("sha256").update("# Same").digest("hex"),
        supersedes: null,
      });
      const db = new DatabaseSync(join(fixture.home, "state", "sorage.sqlite3"));
      db.prepare("UPDATE idempotency_keys SET request_hash = ? WHERE key = ? AND scope = 'send'").run(
        createHash("sha256").update(canonical).digest("hex"),
        key,
      );
      db.close();
    }
    const registered = nested ? join(workspace, "nested") : workspace;
    if (nested) mkdirSync(registered);
    expect(sorage(["project", "add", "--name", "Gamma", "--dir", registered], { home: fixture.home }).status).toBe(0);
    if (nested) {
      expect(
        sorage(["config", "set", "handoff.allowUnregisteredSenders", "false", "--as-user", "--json"], {
          home: fixture.home,
        }).status,
      ).toBe(0);
    }
    const replay = sorage(args, { home: fixture.home, cwd: workspace });
    expect(replay.status).toBe(0);
    const data = (envelopeOf(replay) as { data: { handoffs: Array<{ handoffId: string }>; replayed: boolean } }).data;
    expect(data.replayed).toBe(true);
    expect(data.handoffs[0]?.handoffId).toBe(firstId);
    if (nested) {
      const newSend = sorage([...args.slice(0, -2), "9b7689b1-095c-4a17-aa02-8074d9ea02d9", "--json"], {
        home: fixture.home,
        cwd: workspace,
      });
      expect(errorEnvelopeOf(newSend).error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
    }
    const wrong = sorage(args, { home: fixture.home, cwd: fixture.workA });
    expect(wrong.status).toBe(75);
    expect(errorEnvelopeOf(wrong).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("sends from an unbound directory, lists the workspace outbox, and guards downgrades", () => {
    const fixture = twoProjectFixture("aj05");
    const workspace = unboundDir("aj05-workspace-");
    const document = join(fixture.home, "note.md");
    writeFileSync(document, "# From the workspace\n", "utf8");

    const send = sorage(
      [
        "send",
        "--to",
        "beta",
        "--title",
        "From the workspace",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      {
        home: fixture.home,
        cwd: workspace,
      },
    );
    expect(send.status).toBe(0);
    const id = (envelopeOf(send) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId as string;

    const outbox = sorage(["outbox", "--current-workspace", "--json"], { home: fixture.home, cwd: workspace });
    expect(outbox.status).toBe(0);
    expect(outbox.stdout).toContain(id);

    // The downgrade journey runs in the guarded posture: the installation default
    // allows unregistered senders, so the journey disables that key first.
    const guarded = sorage(["config", "set", "handoff.allowUnregisteredSenders", "false", "--as-user", "--json"], {
      home: fixture.home,
    });
    expect(guarded.status).toBe(0);

    const ancestor = unboundDir("aj05-ancestor-");
    const nested = join(ancestor, "nested");
    mkdirSync(nested, { recursive: true });
    const registerBind = sorage(["project", "add", "--name", "Delta", "--dir", nested, "--json"], {
      home: fixture.home,
    });
    expect(registerBind.status).toBe(0);

    const document2 = join(fixture.home, "note2.md");
    writeFileSync(document2, "# Downgrade probe\n", "utf8");
    const downgrade = sorage(
      ["send", "--to", "beta", "--title", "Downgrade", "--file", document2, "--allow-external-source", "--json"],
      {
        home: fixture.home,
        cwd: ancestor,
      },
    );
    expect(downgrade.status).toBe(65);
    expect(errorEnvelopeOf(downgrade).error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
    const allowed = sorage(
      [
        "send",
        "--to",
        "beta",
        "--title",
        "Downgrade",
        "--file",
        document2,
        "--allow-external-source",
        "--allow-unregistered",
        "--json",
      ],
      { home: fixture.home, cwd: ancestor },
    );
    expect(allowed.status).toBe(0);

    // Registering the workspace later gives the Project authority over the earlier Handoff.
    const register = sorage(["project", "add", "--name", "Gamma", "--dir", workspace, "--json"], {
      home: fixture.home,
    });
    expect(register.status).toBe(0);
    const outboxWorkspace = sorage(["outbox", "--current-workspace", "--json"], { home: fixture.home, cwd: workspace });
    expect(outboxWorkspace.status).toBe(0);
    expect(outboxWorkspace.stdout).toContain(id);
    const listing = envelopeOf(outboxWorkspace) as { data: { handoffs: Array<{ id: string; senderKind: string }> } };
    expect(listing.data.handoffs.find((handoff) => handoff.id === id)?.senderKind).toBe("unregistered_workspace");
  });
});
