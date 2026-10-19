import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINARY, makeTempDir, sorage } from "./helpers";

/**
 * The compiled CLI side of the M3-P3 serving boundary (VLT-020, section
 * 11.3): the default-false production fetch returns the readable local path
 * of a healthy Artifact, and an owned-outside symlink planted at the managed
 * leaf refuses with ARTIFACT_CORRUPTED while the events ledger records no
 * first fetch. A selected Vault directory alias remains a legitimate serving
 * configuration.
 */

describe("compiled CLI fetch over the guarded serving boundary", () => {
  it("fetches a healthy Artifact and records exactly one first fetch event", () => {
    const home = makeTempDir("sorage-serving-cli-");
    const sender = join(home, "sender");
    const recipient = join(home, "recipient");
    mkdirSync(sender, { recursive: true });
    mkdirSync(recipient, { recursive: true });
    const brief = join(sender, "brief.md");
    writeFileSync(brief, "# The served brief\n", "utf8");
    expect(sorage(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], { home }).status).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Sender", "--slug", "sender", "--dir", sender, "--json"], {
        home,
        cwd: sender,
      }).status,
    ).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Recipient", "--slug", "recipient", "--dir", recipient, "--json"], {
        home,
        cwd: recipient,
      }).status,
    ).toBe(0);

    const sent = sorage(["send", "--to", "recipient", "--title", "Serving", "--file", brief, "--json"], {
      home,
      cwd: sender,
    });
    expect(sent.status, sent.stderr).toBe(0);
    const handoffId = (JSON.parse(sent.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId;
    if (handoffId === undefined) throw new Error(`sorage send did not report a Handoff id: ${sent.stdout}`);

    const senderFetch = sorage(["fetch", handoffId, "--json"], { home, cwd: sender });
    expect(senderFetch.status, senderFetch.stderr).toBe(0);
    const senderEvents = sorage(["events", handoffId, "--json"], { home, cwd: sender });
    expect(senderEvents.status, senderEvents.stderr).toBe(0);
    expect(senderEvents.stdout).not.toContain("ARTIFACT_FETCHED_FIRST_TIME");
    const fetched = sorage(["fetch", handoffId, "--json"], { home, cwd: recipient });
    expect(fetched.status, fetched.stderr).toBe(0);
    const payload = JSON.parse(fetched.stdout) as { data: { localPath: string } };
    expect(readFileSync(payload.data.localPath, "utf8")).toBe("# The served brief\n");
    expect(sorage(["fetch", handoffId, "--json"], { home, cwd: recipient }).status).toBe(0);

    const events = sorage(["events", handoffId, "--json"], { home, cwd: recipient });
    expect(events.status, events.stderr).toBe(0);
    const timeline = JSON.parse(events.stdout) as { data: Array<{ eventType: string }> };
    expect(timeline.data.filter((event) => event.eventType === "ARTIFACT_FETCHED_FIRST_TIME")).toHaveLength(1);
  });

  it.each(["leaf", "parent", "fifo", "missing"] as const)("refuses %s before recording a first fetch", (kind) => {
    const home = makeTempDir("sorage-serving-cli-canary-");
    const sender = join(home, "sender");
    const recipient = join(home, "recipient");
    mkdirSync(sender, { recursive: true });
    mkdirSync(recipient, { recursive: true });
    const brief = join(sender, "brief.bin");
    writeFileSync(brief, "# The canary brief\n", "utf8");
    expect(sorage(["init", "--vault", join(home, "vault"), "--non-interactive", "--json"], { home }).status).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Sender", "--slug", "sender", "--dir", sender, "--json"], {
        home,
        cwd: sender,
      }).status,
    ).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Recipient", "--slug", "recipient", "--dir", recipient, "--json"], {
        home,
        cwd: recipient,
      }).status,
    ).toBe(0);

    const sent = sorage(["send", "--to", "recipient", "--title", "Canary", "--file", brief, "--json"], {
      home,
      cwd: sender,
    });
    expect(sent.status, sent.stderr).toBe(0);
    const handoffId = (JSON.parse(sent.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId;
    if (handoffId === undefined) throw new Error(`sorage send did not report a Handoff id: ${sent.stdout}`);

    // Resolve the current leaf through the inbox metadata before corrupting it.
    const inbox = sorage(["inbox", "--json"], { home, cwd: recipient });
    expect(inbox.status, inbox.stderr).toBe(0);
    const detail = sorage(["get", handoffId, "--json"], { home, cwd: recipient });
    expect(detail.status, detail.stderr).toBe(0);
    const storageKey = (JSON.parse(detail.stdout) as { data: { currentArtifact: { storageKey: string } } }).data
      .currentArtifact.storageKey;
    const leaf = join(home, "vault", storageKey);
    expect(existsSync(leaf)).toBe(true);
    const outsideDir = join(home, "owned-outside");
    mkdirSync(outsideDir);
    const outside = join(outsideDir, basename(leaf));
    writeFileSync(outside, "owned bytes outside the Vault");
    const outsideInventory = readdirSync(outsideDir);
    rmSync(leaf);
    if (kind === "leaf") symlinkSync(outside, leaf);
    if (kind === "parent") {
      rmSync(dirname(leaf), { recursive: true });
      symlinkSync(outsideDir, dirname(leaf));
    }
    if (kind === "fifo") expect(spawnSync("mkfifo", [leaf]).status).toBe(0);

    const refused = spawnSync(BINARY, ["fetch", handoffId, "--json"], {
      cwd: recipient,
      env: { ...process.env, SORAGE_HOME: home, SORAGE_TEST_REQUEST_ID: undefined },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(refused.error).toBeUndefined();
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("ARTIFACT_CORRUPTED");
    expect(`${refused.stdout}${refused.stderr}`).not.toContain("owned bytes outside the Vault");
    expect(readFileSync(outside, "utf8")).toBe("owned bytes outside the Vault");
    expect(readdirSync(outsideDir)).toEqual(outsideInventory);

    const events = sorage(["events", handoffId, "--json"], { home, cwd: recipient });
    expect(events.status, events.stderr).toBe(0);
    expect(events.stdout).not.toContain("ARTIFACT_FETCHED_FIRST_TIME");
    const after = sorage(["get", handoffId, "--json"], { home, cwd: recipient });
    expect(after.status, after.stderr).toBe(0);
    expect((JSON.parse(after.stdout) as { data: { firstFetchedAt: string | null } }).data.firstFetchedAt).toBeNull();
  });

  it("keeps a selected Vault directory alias a legitimate serving configuration", () => {
    const home = makeTempDir("sorage-serving-cli-alias-");
    const sender = join(home, "sender");
    const recipient = join(home, "recipient");
    mkdirSync(sender, { recursive: true });
    mkdirSync(recipient, { recursive: true });
    const realVault = join(home, "vault-real");
    mkdirSync(realVault, { recursive: true });
    const alias = join(home, "vault-alias");
    symlinkSync(realVault, alias);
    const brief = join(sender, "brief.bin");
    writeFileSync(brief, "# The aliased brief\n", "utf8");
    expect(sorage(["init", "--vault", alias, "--non-interactive", "--json"], { home }).status).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Sender", "--slug", "sender", "--dir", sender, "--json"], {
        home,
        cwd: sender,
      }).status,
    ).toBe(0);
    expect(
      sorage(["project", "add", "--name", "Recipient", "--slug", "recipient", "--dir", recipient, "--json"], {
        home,
        cwd: recipient,
      }).status,
    ).toBe(0);

    const sent = sorage(["send", "--to", "recipient", "--title", "Alias", "--file", brief, "--json"], {
      home,
      cwd: sender,
    });
    expect(sent.status, sent.stderr).toBe(0);
    const handoffId = (JSON.parse(sent.stdout) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
      ?.handoffId;
    if (handoffId === undefined) throw new Error(`sorage send did not report a Handoff id: ${sent.stdout}`);

    const fetched = sorage(["fetch", handoffId, "--json"], { home, cwd: recipient });
    expect(fetched.status, fetched.stderr).toBe(0);
    const payload = JSON.parse(fetched.stdout) as { data: { localPath: string } };
    expect(readFileSync(payload.data.localPath, "utf8")).toBe("# The aliased brief\n");
  });
});
