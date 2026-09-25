import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, errorEnvelopeOf, git, makeTempDir, runCleanups, sorage, twoProjectFixture } from "./helpers";

afterAll(runCleanups);

describe("AJ-19 Project archive and binding replacement", () => {
  it("preserves the Handoff history while replacing one binding through the packaged CLI", () => {
    const fixture = twoProjectFixture("aj19");
    const id = fixture.sendTo("a", "b", "Before archive");
    const db = new DatabaseSync(join(fixture.home, "state", "sorage.sqlite3"));

    const archive = sorage(["project", "archive", "beta", "--json"], { home: fixture.home });
    expect(archive.status).toBe(0);
    expect((envelopeOf(archive) as { data: { status: string } }).data.status).toBe("archived");
    expect(
      (
        db
          .prepare(
            "SELECT actor_kind FROM events WHERE event_type = 'PROJECT_STATUS_ARCHIVED' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { actor_kind: string }
      ).actor_kind,
    ).toBe("user");

    for (const [cwd, recipient] of [
      [fixture.workA, "beta"],
      [fixture.workB, "alpha"],
    ] as const) {
      const refused = sorage(
        [
          "send",
          "--to",
          recipient,
          "--title",
          "Blocked",
          "--file",
          fixture.document,
          "--allow-external-source",
          "--json",
        ],
        { home: fixture.home, cwd },
      );
      expect(refused.status).toBe(65);
      expect(errorEnvelopeOf(refused).error.code).toBe("PROJECT_ARCHIVED");
    }
    const accepted = sorage(["accept", id, "--expected-revision", "1", "--expected-row-version", "1"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(accepted.status).toBe(0);

    const unarchive = sorage(["project", "unarchive", "beta", "--json"], { home: fixture.home });
    expect(unarchive.status).toBe(0);
    expect((envelopeOf(unarchive) as { data: { status: string } }).data.status).toBe("active");
    expect(
      (
        db
          .prepare(
            "SELECT actor_kind FROM events WHERE event_type = 'PROJECT_STATUS_ACTIVE' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { actor_kind: string }
      ).actor_kind,
    ).toBe("user");
    expect(sorage(["config", "set", "handoff.inboxMarker", "true", "--as-user"], { home: fixture.home }).status).toBe(
      0,
    );
    const currentId = fixture.sendTo("a", "b", "After unarchive");
    const sentFromBeta = fixture.sendTo("b", "a", "Historical sender path");
    const before = envelopeOf(sorage(["project", "show", "beta", "--json"], { home: fixture.home })) as {
      data: { project: { id: string }; bindings: Array<{ id: string; directory: string }> };
    };
    const oldBinding = before.data.bindings[0];
    expect(oldBinding?.directory).toBe(realpathSync(fixture.workB));
    const replacement = makeTempDir("aj19-replacement-");
    const moved = sorage(["project", "rebind", "beta", "--from", fixture.workB, "--to", replacement, "--json"], {
      home: fixture.home,
    });
    expect(moved.status).toBe(0);
    expect((envelopeOf(moved) as { data: { id: string; directory: string } }).data).toMatchObject({
      id: oldBinding?.id,
      directory: realpathSync(replacement),
    });
    const after = envelopeOf(sorage(["project", "show", "beta", "--json"], { home: fixture.home })) as {
      data: { project: { id: string }; bindings: Array<{ id: string; directory: string }> };
    };
    expect(after.data.project.id).toBe(before.data.project.id);
    expect(after.data.bindings).toMatchObject([{ id: oldBinding?.id, directory: realpathSync(replacement) }]);
    expect(
      (
        envelopeOf(sorage(["project", "resolve", "--path", replacement, "--json"], { home: fixture.home })) as {
          data: { project?: { slug: string } };
        }
      ).data.project?.slug,
    ).toBe("beta");
    expect(
      (
        envelopeOf(sorage(["project", "resolve", "--path", fixture.workB, "--json"], { home: fixture.home })) as {
          data: { kind: string };
        }
      ).data.kind,
    ).toBe("unregistered_workspace");
    expect(readFileSync(join(replacement, ".sorage", "INBOX.md"), "utf8")).toContain(currentId);
    expect(existsSync(join(fixture.workB, ".sorage", "INBOX.md"))).toBe(false);
    expect(
      db.prepare("SELECT sender_project_id, sender_path_snapshot FROM handoffs WHERE id = ?").get(sentFromBeta),
    ).toMatchObject({ sender_project_id: before.data.project.id, sender_path_snapshot: null });

    const eventCount = () =>
      (
        db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'PROJECT_BINDING_REBOUND'").get() as {
          count: number;
        }
      ).count;
    expect(eventCount()).toBe(1);
    const event = db
      .prepare("SELECT actor_kind, metadata_json FROM events WHERE event_type = 'PROJECT_BINDING_REBOUND'")
      .get() as {
      actor_kind: string;
      metadata_json: string;
    };
    expect(event.actor_kind).toBe("user");
    expect(JSON.parse(event.metadata_json)).toMatchObject({
      oldDirectory: realpathSync(fixture.workB),
      newDirectory: realpathSync(replacement),
    });
    expect(
      sorage(["project", "rebind", "beta", "--from", replacement, "--to", replacement], { home: fixture.home }).status,
    ).toBe(0);
    expect(eventCount()).toBe(1);

    const invalid = makeTempDir("aj19-invalid-");
    rmSync(invalid, { recursive: true });
    for (const [target, status] of [
      [fixture.workA, 65],
      [invalid, 78],
    ] as const) {
      expect(
        sorage(["project", "rebind", "beta", "--from", replacement, "--to", target], { home: fixture.home }).status,
      ).toBe(status);
    }
    expect(eventCount()).toBe(1);
    rmSync(replacement, { recursive: true });
    const finalDir = makeTempDir("aj19-final-");
    expect(
      sorage(["project", "rebind", "beta", "--from", replacement, "--to", finalDir], { home: fixture.home }).status,
    ).toBe(0);
    expect(eventCount()).toBe(2);

    const repo = makeTempDir("aj19-git-");
    git(repo, ["init", "--initial-branch=main"]);
    const gitMove = sorage(["project", "rebind", "alpha", "--from", fixture.workA, "--to", repo, "--json"], {
      home: fixture.home,
    });
    expect(gitMove.status).toBe(0);
    expect((envelopeOf(gitMove) as { data: { bindingKind: string; directory: string } }).data).toMatchObject({
      bindingKind: "git_repository",
      directory: realpathSync(join(repo, ".git")),
    });
    db.close();
  });
});
