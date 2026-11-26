import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/program";

/**
 * The `sorage send` CLI surface of TASK-029 through the real wiring: an initialized
 * temporary installation, two registered Projects, and a fan-out whose JSON envelope
 * prints every generated Handoff UUID with one dispatch group (CLI-007, CLI-008).
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

interface SendEnvelope {
  ok: boolean;
  data: {
    handoffs: Array<{
      handoffId: string;
      recipientSlug: string;
      storageKey: string | null;
      revision: number;
      rowVersion: number;
    }>;
    dispatchGroupId: string | null;
    replayed: boolean;
  };
}

describe("sorage send", () => {
  it("hands one document to two recipients through one dispatch group", () => {
    const home = tempHome("sorage-send-cli-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workA = join(home, "work-a");
    const workB = join(home, "work-b");
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);
    const document = join(home, "brief.md");
    writeFileSync(document, "# The brief\n\nShared content.\n");

    const send = capture();
    const exit = runCli(
      [
        "send",
        "--to",
        "alpha",
        "--to",
        "beta",
        "--title",
        "Design brief",
        "--file",
        document,
        "--allow-external-source",
        "--json",
      ],
      send.ports,
    );
    if (exit !== 0) throw new Error(`send failed (${exit}): ${send.errText()}`);
    expect(exit).toBe(0);
    const envelope = JSON.parse(send.outText()) as SendEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.handoffs).toHaveLength(2);
    expect(envelope.data.dispatchGroupId).not.toBeNull();
    expect(new Set(envelope.data.handoffs.map((handoff) => handoff.recipientSlug))).toEqual(new Set(["alpha", "beta"]));
    for (const handoff of envelope.data.handoffs) {
      expect(handoff.revision).toBe(1);
      expect(handoff.rowVersion).toBe(1);
      expect(handoff.storageKey).toBeNull();
    }
    expect(send.errText()).toBe("");
  });

  it("refuses --file and --body together as a usage error at exit 2", () => {
    const _home = tempHome("sorage-send-usage-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const send = capture();
    expect(runCli(["send", "--to", "alpha", "--title", "T", "--file", "/tmp/x", "--body", "text"], send.ports)).toBe(2);
    expect(send.errText()).toContain("exactly one of --file or --body");
  });

  it("refuses single and fan-out self-handoffs at exit 64 with site-specific recovery and zero DB writes (HND-027)", () => {
    const home = tempHome("sorage-send-self-cli-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workA = join(home, "work-a");
    const workB = join(home, "work-b");
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    const addA = capture();
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA, "--json"], addA.ports)).toBe(0);
    const alphaId = (JSON.parse(addA.outText()) as { data: { project: { id: string } } }).data.project.id;
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);

    const single = capture();
    expect(
      runCli(["send", "--as", "alpha", "--to", "ALPHA", "--title", "Self", "--body", "# Self", "--json"], single.ports),
    ).toBe(64);
    expect(JSON.parse(single.errText())).toMatchObject({
      ok: false,
      error: {
        code: "HANDOFF_INVALID_INPUT",
        details: { senderProjectId: alphaId, recipientSlug: "alpha" },
        recovery: {
          suggestedCommand: "Choose a different --to recipient Project, or send with --as <other-project> or --as-user",
        },
      },
    });

    const fanout = capture();
    expect(
      runCli(
        ["send", "--as", "alpha", "--to", "beta", "--to", "alpha", "--title", "Fanout", "--body", "# Fanout", "--json"],
        fanout.ports,
      ),
    ).toBe(64);
    expect(JSON.parse(fanout.errText())).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID_INPUT", details: { senderProjectId: alphaId, recipientSlug: "alpha" } },
    });

    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      for (const table of ["handoffs", "artifacts", "content_records", "pending_fs_ops"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }
    } finally {
      db.close();
    }
  });

  it("refuses unregistered send from '/', enforces git_repository working-tree containment, ignores legacy '/' rows, and keeps '/' fail-closed (ADR-0041)", () => {
    const original = process.cwd();
    const home = tempHome("sorage-send-root-isolation-");
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const workA = join(home, "work-a");
    const workB = join(home, "work-b");
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Beta", "--dir", workB], capture().ports)).toBe(0);

    // Seed an unrelated legacy '/' binding row.
    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    const inst = db.prepare("SELECT installation_id FROM project_bindings LIMIT 1").get() as {
      installation_id: string;
    };
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES ('p-leg', 'legacy-root', 'Legacy Root', 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b-leg', 'p-leg', ?, '/', 'directory', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
    ).run(inst.installation_id);
    db.close();

    try {
      // 1. Valid Project file send succeeds despite the seeded legacy '/' row.
      const docA = join(workA, "brief.md");
      writeFileSync(docA, "# Valid send past legacy root\n");
      process.chdir(workA);
      const validSend = capture();
      expect(runCli(["send", "--to", "beta", "--title", "Valid", "--file", docA, "--json"], validSend.ports)).toBe(0);

      // 2. Unregistered send from cwd='/' fails with SENDER_IDENTITY_DOWNGRADE (exit 65) rather than resolving to legacy-root.
      process.chdir("/");
      const downgrade = capture();
      expect(runCli(["send", "--to", "beta", "--title", "From root", "--body", "hi", "--json"], downgrade.ports)).toBe(
        65,
      );
      expect((JSON.parse(downgrade.errText()) as { error: { code: string } }).error.code).toBe(
        "SENDER_IDENTITY_DOWNGRADE",
      );

      // 3. File send from cwd='/' with --allow-unregistered stays fail-closed on VLT-016 (SOURCE_OUTSIDE_WORKSPACE, exit 77).
      const rootExternal = capture();
      expect(
        runCli(
          ["send", "--to", "beta", "--allow-unregistered", "--title", "From root file", "--file", docA, "--json"],
          rootExternal.ports,
        ),
      ).toBe(77);
      expect((JSON.parse(rootExternal.errText()) as { error: { code: string } }).error.code).toBe(
        "SOURCE_OUTSIDE_WORKSPACE",
      );

      // 4. Vault inside a bound git_repository working tree refuses file send with VAULT_CONTAINMENT (exit 64).
      const db2 = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
      db2
        .prepare(
          "INSERT INTO projects (id, slug, display_name, status, created_at, updated_at) VALUES ('p-git-wrap', 'git-wrap', 'Git Wrap', 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
        )
        .run();
      db2
        .prepare(
          "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('b-git-wrap', 'p-git-wrap', ?, ?, 'git_repository', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
        )
        .run(inst.installation_id, join(home, ".git"));
      db2.close();

      process.chdir(workA);
      const contained = capture();
      expect(runCli(["send", "--to", "beta", "--title", "Blocked", "--file", docA, "--json"], contained.ports)).toBe(
        64,
      );
      expect((JSON.parse(contained.errText()) as { error: { code: string } }).error.code).toBe("VAULT_CONTAINMENT");
    } finally {
      process.chdir(original);
    }
  });
});
