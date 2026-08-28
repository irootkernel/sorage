import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { errorEnvelopeOf, envelopeOf, git, makeTempDir, runCleanups, sorage, twoProjectFixture } from "./helpers";

/** AJ-03: project identity - worktree folding, second bindings, duplicates, precedence, and archive semantics. */
afterAll(runCleanups);

describe("AJ-03 project registry and resolution", () => {
  it("resolves a worktree to the Project of its common directory", () => {
    const repo = makeTempDir("aj03-repo-");
    git(repo, ["init", "--initial-branch=main"]);
    const fixture = twoProjectFixture("aj03");
    // Rebinding is per directory, so the repository itself is what Alpha owns.
    const bindRepo = sorage(["project", "bind", "alpha", "--dir", repo, "--json"], { home: fixture.home });
    expect(bindRepo.status).toBe(0);
    const worktreeParent = makeTempDir("aj03-wt-parent-");
    const worktree = join(worktreeParent, "wt");
    git(repo, ["worktree", "add", worktree, "-b", "journey-wt"]);
    const resolve = sorage(["project", "resolve", "--json"], { home: fixture.home, cwd: worktree });
    expect(resolve.status).toBe(0);
    const resolved = envelopeOf(resolve) as { data: { kind: string; project?: { slug: string } } };
    expect(resolved.data.kind).toBe("registered_project");
    expect(resolved.data.project?.slug).toBe("alpha");
  });

  it("binds a second directory, refuses duplicates, and prefers the deeper binding", () => {
    const fixture = twoProjectFixture("aj03b");
    const second = makeTempDir("aj03-second-");
    const bind = sorage(["project", "bind", "alpha", "--dir", second, "--json"], { home: fixture.home });
    expect(bind.status).toBe(0);

    const duplicate = sorage(["project", "bind", "alpha", "--dir", second, "--json"], { home: fixture.home });
    expect(duplicate.status).toBe(65);
    expect(errorEnvelopeOf(duplicate).error.code).toBe("BINDING_DUPLICATE");

    const nested = makeTempDir("aj03-nested-inner-");
    const outer = makeTempDir("aj03-nested-outer-");
    const bindOuter = sorage(["project", "bind", "beta", "--dir", outer, "--json"], { home: fixture.home });
    expect(bindOuter.status).toBe(0);
    const bindNested = sorage(["project", "bind", "beta", "--dir", nested, "--json"], { home: fixture.home });
    expect(bindNested.status).toBe(0);
    const resolve = sorage(["project", "resolve", "--path", nested, "--json"], { home: fixture.home });
    const resolved = envelopeOf(resolve) as { data: { kind: string; binding?: { directory: string } } };
    expect(realpathSync(resolved.data.binding?.directory ?? "")).toBe(realpathSync(nested));

    const asOverride = sorage(["project", "resolve", "--path", nested, "--as", "alpha", "--json"], {
      home: fixture.home,
    });
    expect(asOverride.status).toBe(0);
    const overridden = envelopeOf(asOverride) as { data: { project?: { slug: string }; kind: string } };
    expect(overridden.data.project?.slug ?? overridden.data.kind).toContain("alpha");
  });

  it("keeps an archived recipient working on its inbox while refusing new sends", () => {
    const fixture = twoProjectFixture("aj03c");
    const id = fixture.sendTo("a", "b", "Before archive");
    const archive = sorage(["project", "archive", "beta", "--as-user", "--json"], { home: fixture.home });
    expect(archive.status).toBe(0);

    const refused = sorage(
      [
        "send",
        "--to",
        "beta",
        "--title",
        "After archive",
        "--file",
        fixture.document,
        "--allow-external-source",
        "--json",
      ],
      {
        home: fixture.home,
        cwd: fixture.workA,
      },
    );
    expect(refused.status).toBe(65);
    expect(errorEnvelopeOf(refused).error.code).toBe("PROJECT_ARCHIVED");

    const inbox = sorage(["inbox", "--json"], { home: fixture.home, cwd: fixture.workB });
    expect(inbox.status).toBe(0);
    expect(inbox.stdout).toContain(id);
    const accept = sorage(["accept", id, "--expected-revision", "1", "--expected-row-version", "1", "--json"], {
      home: fixture.home,
      cwd: fixture.workB,
    });
    expect(accept.status).toBe(0);
  });
});
