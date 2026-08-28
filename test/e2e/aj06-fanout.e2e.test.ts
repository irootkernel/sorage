import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

/** AJ-06: fan-out independence through one dispatch group, including the scale variant. */
afterAll(runCleanups);

function registerFixture(
  prefix: string,
  recipients: number,
): { home: string; sender: string; recipientDirs: string[]; slugs: string[] } {
  const home = makeTempDir(`${prefix}-home-`);
  const sender = makeTempDir(`${prefix}-sender-`);
  const recipientDirs: string[] = [];
  const slugs: string[] = [];
  const init = sorage(["init", "--non-interactive"], { home });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const addSender = sorage(["project", "add", "--name", "Sender", "--dir", sender], { home });
  if (addSender.status !== 0) throw new Error(`sender registration failed: ${addSender.stderr}`);
  for (let index = 0; index < recipients; index += 1) {
    const dir = makeTempDir(`${prefix}-r${index}-`);
    const add = sorage(["project", "add", "--name", `Recipient ${index}`, "--dir", dir], { home });
    if (add.status !== 0) throw new Error(`recipient ${index} registration failed: ${add.stderr}`);
    recipientDirs.push(dir);
    slugs.push(`recipient-${index}`);
  }
  writeFileSync(`${home}/brief.md`, "# Shared brief\n", "utf8");
  return { home, sender, recipientDirs, slugs };
}

describe("AJ-06 fan-out", () => {
  it("fans out to three recipients whose review loops diverge independently", () => {
    const fixture = registerFixture("aj06-3", 3);
    const run = sorage(
      [
        "send",
        "--to",
        fixture.slugs[0] as string,
        "--to",
        fixture.slugs[1] as string,
        "--to",
        fixture.slugs[2] as string,
        "--title",
        "Shared",
        "--file",
        `${fixture.home}/brief.md`,
        "--allow-external-source",
        "--json",
      ],
      { home: fixture.home, cwd: fixture.sender },
    );
    expect(run.status).toBe(0);
    const created = envelopeOf(run) as {
      data: {
        handoffs: Array<{ handoffId: string; recipientSlug: string; storageKey: string }>;
        dispatchGroupId: string;
      };
    };
    expect(created.data.handoffs).toHaveLength(3);
    expect(created.data.dispatchGroupId).not.toBeNull();
    expect(new Set(created.data.handoffs.map((handoff) => handoff.recipientSlug))).toEqual(new Set(fixture.slugs));
    expect(new Set(created.data.handoffs.map((handoff) => handoff.storageKey)).size).toBe(3);

    const ids = created.data.handoffs.map((handoff) => handoff.handoffId);
    const [h0, h1, h2] = [ids[0], ids[1], ids[2]] as [string, string, string];
    // Recipient 0 requests changes; recipient 1 accepts; recipient 2 declines.
    expect(
      sorage(["review", "set", h0, "--text", "Rework", "--json"], { home: fixture.home, cwd: fixture.recipientDirs[0] })
        .status,
    ).toBe(0);
    expect(
      sorage(["accept", h1, "--expected-revision", "1", "--expected-row-version", "1", "--json"], {
        home: fixture.home,
        cwd: fixture.recipientDirs[1],
      }).status,
    ).toBe(0);
    expect(
      sorage(["decline", h2, "--reason", "Not needed", "--expected-row-version", "1", "--json"], {
        home: fixture.home,
        cwd: fixture.recipientDirs[2],
      }).status,
    ).toBe(0);

    // The sender revises only recipient 0's loop; siblings never see each other.
    writeFileSync(`${fixture.home}/reworked.md`, "# Reworked\n", "utf8");
    expect(
      sorage(["revise", h0, "--file", `${fixture.home}/reworked.md`, "--allow-external-source", "--json"], {
        home: fixture.home,
        cwd: fixture.sender,
      }).status,
    ).toBe(0);
    expect(
      sorage(["accept", h0, "--expected-revision", "2", "--expected-row-version", "3", "--json"], {
        home: fixture.home,
        cwd: fixture.recipientDirs[0],
      }).status,
    ).toBe(0);
    for (const dir of fixture.recipientDirs.slice(1)) {
      const inbox = sorage(["inbox", "--json"], { home: fixture.home, cwd: dir });
      expect(inbox.status).toBe(0);
      expect(inbox.stdout).not.toContain(h0);
    }
  });

  it("completes the one-hundred-recipient scale variant under one dispatch group", () => {
    const fixture = registerFixture("aj06-100", 100);
    const args = ["send"];
    for (const slug of fixture.slugs) args.push("--to", slug as string);
    args.push("--title", "At scale", "--file", `${fixture.home}/brief.md`, "--allow-external-source", "--json");
    const run = sorage(args, { home: fixture.home, cwd: fixture.sender });
    expect(run.status).toBe(0);
    const created = envelopeOf(run) as { data: { handoffs: Array<{ handoffId: string }>; dispatchGroupId: string } };
    expect(created.data.handoffs).toHaveLength(100);
    expect(created.data.dispatchGroupId).not.toBeNull();
    expect(new Set(created.data.handoffs.map((handoff) => handoff.handoffId)).size).toBe(100);
    const verify = sorage(["vault", "verify", "--json"], { home: fixture.home });
    expect(verify.status).toBe(0);
  }, 240_000);
});
