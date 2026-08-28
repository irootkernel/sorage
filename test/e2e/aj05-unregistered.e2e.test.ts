import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
